import { describe, expect, it, vi } from "vitest";
import "../translator/registerAll.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { addBufferToUsage, attachRawUsage, filterUsageForFormat } from "../../open-sse/utils/usageTracking.js";
import { createSSEStream } from "../../open-sse/utils/stream.js";
import { handleNonStreamingResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";
import { handleForcedSSEToJson } from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";
import { handleStreamingResponse } from "../../open-sse/handlers/chatCore/streamingHandler.js";
import { createStreamController } from "../../open-sse/utils/streamHandler.js";

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn().mockResolvedValue(undefined),
  saveRequestDetail: vi.fn().mockResolvedValue(undefined),
  saveRequestUsage: vi.fn().mockResolvedValue(undefined),
}));

const raw = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 50 };
const openAIUsage = {
  prompt_tokens: 450, completion_tokens: 20, total_tokens: 470,
  prompt_tokens_details: { cached_tokens: 300, cache_creation_tokens: 50 },
};
const chatResponse = (usage = openAIUsage) => ({
  id: "chatcmpl-orr-test", object: "chat.completion", model: "test-model",
  choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
  usage,
});
const chatChunk = (delta, finishReason = null, usage) => ({
  id: "chatcmpl-orr-test", model: "test-model",
  choices: [{ index: 0, delta, finish_reason: finishReason }],
  ...(usage ? { usage } : {}),
});
const encodeSse = (chunks) => chunks.map(chunk => `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`).join("");
const parseEvents = (text) => text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));

async function streamAsync(chunks, targetFormat = FORMATS.OPENAI, options = {}) {
  const text = encodeSse(chunks).trimEnd() + (options.noTrailingNewline ? "" : "\n\n");
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  const upstream = new ReadableStream({
    start(controller) {
      // Real transport can split both JSON and UTF-8 code points across reads.
      for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.slice(offset, offset + 7));
      controller.close();
    },
  });
  const onStreamComplete = vi.fn();
  const output = await new Response(upstream.pipeThrough(createSSEStream({
    sourceFormat: FORMATS.CLAUDE, targetFormat, onStreamComplete,
    body: { model: "test-model", messages: [{ role: "user", content: "Hello" }] },
  }))).text();
  return { output, events: parseEvents(output), onStreamComplete };
}

function handlerContext(body, targetFormat = FORMATS.OPENAI) {
  return {
    providerResponse: new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }),
    sourceFormat: FORMATS.CLAUDE, targetFormat, provider: "test-provider", model: "test-model",
    body: { model: "test-model", messages: [] }, requestStartTime: Date.now(),
    clientRawRequest: { endpoint: "/v1/messages" }, trackDone: vi.fn(), appendLog: vi.fn(),
    reqLogger: { logProviderResponse: vi.fn(), logConvertedResponse: vi.fn() },
  };
}

function expectUsage(usage, expected = raw) {
  expect(usage).toMatchObject({ ...expected, input_tokens: expected.input_tokens + 2000 });
  expect(usage._orr_raw).toEqual(expected);
  // ORR's extractor prioritizes prompt_tokens: do NOT expose an ambiguous alias.
  expect(usage._orr_raw).not.toHaveProperty("prompt_tokens");
}

describe("Anthropic _orr_raw contract", () => {
  it.each([
    raw,
    { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 50 },
    { input_tokens: 0, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 0 },
    { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  ])("keeps four unbuffered counters: %j", (usage) => {
    const original = structuredClone(usage);
    const result = attachRawUsage(filterUsageForFormat(addBufferToUsage(usage), FORMATS.CLAUDE), usage, FORMATS.CLAUDE);
    expectUsage(result, usage);
    expect(usage).toEqual(original);
  });

  it("keeps the legacy OpenAI raw shape and cache details", () => {
    const result = attachRawUsage(filterUsageForFormat(addBufferToUsage(openAIUsage), FORMATS.OPENAI), openAIUsage, FORMATS.OPENAI);
    expect(result._orr_raw).toEqual({ prompt_tokens: 450, completion_tokens: 20 });
    expect(result.prompt_tokens).toBe(2450);
    expect(result.prompt_tokens_details).toEqual(openAIUsage.prompt_tokens_details);
  });
});

describe("Messages JSON usage", () => {
  it("finishes the Gemini-to-Messages conversion with cache and reasoning usage", async () => {
    const result = await handleNonStreamingResponse(handlerContext({
      candidates: [{ content: { parts: [{ text: "Hello" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 400, cachedContentTokenCount: 300, candidatesTokenCount: 15, thoughtsTokenCount: 5, totalTokenCount: 420 },
    }, FORMATS.GEMINI));
    const json = await result.response.json();
    expect(json.type).toBe("message");
    expectUsage(json.usage, { ...raw, cache_creation_input_tokens: 0 });
  });

  it("finishes the Ollama-to-Messages conversion", async () => {
    const result = await handleNonStreamingResponse(handlerContext({
      model: "test-model", message: { role: "assistant", content: "Hello" }, done: true,
      done_reason: "stop", prompt_eval_count: 100, eval_count: 20,
    }, FORMATS.OLLAMA));
    const json = await result.response.json();
    expect(json.type).toBe("message");
    expectUsage(json.usage, { ...raw, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  });

  it("keeps cached input and tools when a Responses provider forces SSE", async () => {
    const ctx = handlerContext(null, FORMATS.OPENAI_RESPONSES);
    const chunks = [
      { type: "response.created", response: { id: "resp-test" } },
      { type: "response.output_item.done", output_index: 0, item: { type: "function_call", call_id: "call-test", name: "Read", arguments: '{"file_path":"README.md"}' } },
      { type: "response.completed", response: { usage: { input_tokens: 400, output_tokens: 20, total_tokens: 420, input_tokens_details: { cached_tokens: 300 } } } },
    ];
    ctx.providerResponse = new Response(chunks.map(chunk => `event: ${chunk.type}\ndata: ${JSON.stringify(chunk)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    const result = await handleForcedSSEToJson(ctx);
    const json = await result.response.json();
    expect(json.type).toBe("message");
    expect(json.content).toContainEqual({ type: "tool_use", id: "call-test", name: "Read", input: { file_path: "README.md" } });
    expectUsage(json.usage, { ...raw, cache_creation_input_tokens: 0 });
  });

  it("keeps cache-exclusive input and raw counters for a native Anthropic response", async () => {
    const response = { id: "msg-test", type: "message", role: "assistant", model: "test-model", content: [{ type: "text", text: "Hello" }], usage: raw };
    const result = await handleNonStreamingResponse(handlerContext(response, FORMATS.CLAUDE));
    expectUsage((await result.response.json()).usage);
  });

  it("converts OpenAI inclusive input and cache details without losing output", async () => {
    const result = await handleNonStreamingResponse(handlerContext(chatResponse()));
    const json = await result.response.json();
    expect(json.type).toBe("message");
    expectUsage(json.usage);
  });

  it("returns Messages with raw usage when a chat provider forces SSE", async () => {
    const ctx = handlerContext(null);
    ctx.providerResponse = new Response(encodeSse([
      chatChunk({ content: "Hello" }), chatChunk({}, "stop", openAIUsage), "[DONE]",
    ]), { headers: { "content-type": "text/event-stream" } });
    const result = await handleForcedSSEToJson(ctx);
    const json = await result.response.json();
    expect(json.type).toBe("message");
    expectUsage(json.usage);
  });
});

describe("Messages SSE usage", () => {
  it("uses the native Messages pipeline in the production handler", async () => {
    const ctx = handlerContext(null, FORMATS.CLAUDE);
    ctx.providerResponse = new Response(": keepalive\n\n" + encodeSse([
      { type: "message_start", message: { id: "msg-test", usage: { ...raw, output_tokens: 1 } } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } },
      { type: "message_stop" },
    ]), { headers: { "content-type": "text/event-stream" } });
    const onStreamComplete = vi.fn();
    const result = await handleStreamingResponse({ ...ctx, streamController: createStreamController(), onStreamComplete });
    const output = await result.response.text();
    const events = parseEvents(output);
    expect(output).toContain(": keepalive");
    expect(output).not.toContain("[DONE]");
    expectUsage(events.find(event => event.type === "message_delta").usage, { ...raw, output_tokens: 0 });
    expect(onStreamComplete).toHaveBeenCalledTimes(1);
    expect(onStreamComplete.mock.calls[0][1]).toMatchObject({ ...raw, output_tokens: 0 });
  });

  it("does not treat early partial usage as final before a usage-only trailer", async () => {
    const { events } = await streamAsync([
      chatChunk({ content: "Hello" }, null, { ...openAIUsage, completion_tokens: 1 }),
      chatChunk({}, "stop"), { choices: [], usage: openAIUsage }, "[DONE]",
    ]);
    expectUsage(events.find(event => event.type === "message_delta").usage);
    expect(events.filter(event => event.type === "message_stop")).toHaveLength(1);
  });

  it("preserves final input/output/cache fields after OpenAI translation", async () => {
    const { events, output } = await streamAsync([
      chatChunk({ content: "Привет" }), chatChunk({}, "stop", openAIUsage), "[DONE]",
    ]);
    expect(output).toContain("Привет");
    expect(output).toContain("event: message_delta");
    expectUsage(events.find(event => event.type === "message_delta").usage);
  });

  it("merges native start and cumulative delta usage, preserving pings and signatures", async () => {
    const { events } = await streamAsync([
      { type: "message_start", message: { id: "msg-test", usage: { ...raw, output_tokens: 1 } } },
      { type: "ping" },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "test-signature" } },
      { type: "message_delta", delta: {}, usage: { output_tokens: 10 } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } },
      { type: "message_stop" },
    ], FORMATS.CLAUDE);
    expect(events).toContainEqual({ type: "ping" });
    expect(events.some(event => event.delta?.signature === "test-signature")).toBe(true);
    expectUsage(events.filter(event => event.type === "message_delta").at(-1).usage);
    expect(events.at(-1).type).toBe("message_stop");
  });

  it("keeps raw counters when the final usage line has no newline", async () => {
    const { events } = await streamAsync([
      chatChunk({ content: "Hello" }), chatChunk({}, "stop", openAIUsage),
    ], FORMATS.OPENAI, { noTrailingNewline: true });
    expectUsage(events.find(event => event.type === "message_delta").usage);
  });

  it("uses the trailing usage-only chunk before emitting message_stop", async () => {
    const { events } = await streamAsync([
      chatChunk({ content: "Hello" }), chatChunk({}, "stop"),
      { choices: [], usage: openAIUsage }, "[DONE]",
    ]);
    expect(events.filter(event => event.type === "message_stop")).toHaveLength(1);
    expectUsage(events.find(event => event.type === "message_delta").usage);
    expect(events.at(-1).type).toBe("message_stop");
  });
});
