import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ───────────────────────────────────────────────────────────────

const mockConnections = [];
const mockNodes = [];
const mockCustomModels = [];
const mockModelAliases = { value: {} };

function resetMockData() {
  mockConnections.length = 0;
  mockNodes.length = 0;
  mockCustomModels.length = 0;
  mockModelAliases.value = {};
}

vi.mock("../../src/lib/localDb.js", () => ({
  getProviderConnections: vi.fn(() => mockConnections),
  getCustomModels: vi.fn(() => mockCustomModels),
  getModelAliases: vi.fn(() => mockModelAliases.value),
  getProviderNodes: vi.fn(() => mockNodes),
}));

vi.mock("../../src/lib/disabledModelsDb.js", () => ({
  getDisabledModels: vi.fn(() => null),
}));

vi.mock("../../src/app/api/providers/[id]/models/route.js", () => ({
  fetchProviderModelsForConnection: vi.fn(),
}));

vi.mock("../../src/shared/constants/providers.js", () => ({
  ID_TO_ALIAS: { minimax: "minimax", codex: "cx", claude: "cc" },
  getProviderAlias: vi.fn((id) => {
    const map = { minimax: "minimax", codex: "cx", claude: "cc" };
    return map[id] || id;
  }),
  resolveProviderId: vi.fn((aliasOrId) => {
    const map = { minimax: "minimax", "minimax-cn": "minimax-cn", cx: "codex", cc: "claude", codex: "codex", claude: "claude" };
    return map[aliasOrId] || aliasOrId;
  }),
  isOpenAICompatibleProvider: vi.fn((id) => typeof id === "string" && id.startsWith("openai-compatible-")),
  isAnthropicCompatibleProvider: vi.fn((id) => typeof id === "string" && id.startsWith("anthropic-compatible-")),
}));

vi.mock("../../src/shared/constants/models.js", () => ({
  PROVIDER_ID_TO_ALIAS: {},
  getModelsByProviderId: vi.fn((providerId) => {
    const models = {
      minimax: [
        { id: "MiniMax-M1", name: "MiniMax M1", type: "llm" },
        { id: "MiniMax-M2", name: "MiniMax M2", type: "llm" },
      ],
      codex: [
        { id: "codex-mini", name: "Codex Mini", type: "llm" },
        { id: "o3", name: "O3", type: "llm" },
      ],
      claude: [
        { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", type: "llm" },
        { id: "claude-opus-4-20250514", name: "Claude Opus 4", type: "llm" },
      ],
    };
    return models[providerId] || [];
  }),
}));

// Import after mocks
import { GET as getProviderModels } from "../../src/app/api/integrations/providers/by-type/[provider]/models/route.js";
import { getProviderConnections } from "../../src/lib/localDb.js";
import { getModelsByProviderId } from "../../src/shared/constants/models.js";

// ── Helpers ─────────────────────────────────────────────────────────────

function makeModelsRequest(provider, source = "", extraParams = {}) {
  const params = new URLSearchParams();
  if (source) params.set("source", source);
  for (const [key, value] of Object.entries(extraParams)) {
    params.set(key, String(value));
  }
  const sp = params.toString() ? `?${params.toString()}` : "";
  const url = `http://localhost:20128/api/integrations/providers/by-type/${provider}/models${sp}`;
  const req = new Request(url);
  return req;
}

// ========================================================================
// Static models — minimax
// ========================================================================

describe("GET /api/integrations/providers/by-type/{provider}/models — static", () => {
  beforeEach(() => {
    resetMockData();
    vi.clearAllMocks();
  });

  it("minimax source=static returns publicId with prefix minimax/", async () => {
    const req = makeModelsRequest("minimax", "static");
    const res = await getProviderModels(req, {
      params: Promise.resolve({ provider: "minimax" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("static");
    expect(body.models.length).toBeGreaterThan(0);
    for (const m of body.models) {
      expect(m.publicId).toMatch(/^minimax\//);
    }
  });

  it("returns 404 for unsupported provider", async () => {
    const req = makeModelsRequest("unsupported-provider", "static");
    const res = await getProviderModels(req, {
      params: Promise.resolve({ provider: "unsupported-provider" }),
    });
    expect(res.status).toBe(404);
  });
});

// ========================================================================
// Alias normalization — codex/cx and claude/cc
// ========================================================================

describe("provider alias normalization", () => {
  beforeEach(() => {
    resetMockData();
    vi.clearAllMocks();
  });

  it('"codex" resolves to the same provider as "cx"', async () => {
    const req1 = makeModelsRequest("codex", "static");
    const res1 = await getProviderModels(req1, {
      params: Promise.resolve({ provider: "codex" }),
    });
    const body1 = await res1.json();

    const req2 = makeModelsRequest("cx", "static");
    const res2 = await getProviderModels(req2, {
      params: Promise.resolve({ provider: "cx" }),
    });
    const body2 = await res2.json();

    // Both should resolve to the same provider
    expect(body1.provider).toBe(body2.provider);
    expect(body1.alias).toBe(body2.alias);
    // Same models
    expect(body1.models.map((m) => m.id)).toEqual(body2.models.map((m) => m.id));
  });

  it('"claude" resolves to the same provider as "cc"', async () => {
    const req1 = makeModelsRequest("claude", "static");
    const res1 = await getProviderModels(req1, {
      params: Promise.resolve({ provider: "claude" }),
    });
    const body1 = await res1.json();

    const req2 = makeModelsRequest("cc", "static");
    const res2 = await getProviderModels(req2, {
      params: Promise.resolve({ provider: "cc" }),
    });
    const body2 = await res2.json();

    expect(body1.provider).toBe(body2.provider);
    expect(body1.alias).toBe(body2.alias);
    expect(body1.models.map((m) => m.id)).toEqual(body2.models.map((m) => m.id));
  });
});

// ========================================================================
// Effective models — enabledModels / disabledModels
// ========================================================================

describe("effective models", () => {
  beforeEach(() => {
    resetMockData();
    vi.clearAllMocks();
  });

  it("effective respects enabledModels from connection", async () => {
    mockConnections.push({
      id: "conn-1",
      provider: "minimax",
      authType: "apikey",
      isActive: true,
      providerSpecificData: {
        enabledModels: ["MiniMax-M1"],
      },
    });

    const req = makeModelsRequest("minimax", "effective");
    const res = await getProviderModels(req, {
      params: Promise.resolve({ provider: "minimax" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("effective");
    // Should only include enabled model
    const ids = body.models.map((m) => m.id);
    expect(ids).toEqual(["MiniMax-M1"]);
  });

  it("effective excludes disabled models", async () => {
    const { getDisabledModels } = await import("../../src/lib/disabledModelsDb.js");
    getDisabledModels.mockResolvedValueOnce({
      minimax: ["MiniMax-M2"],
    });

    mockConnections.push({
      id: "conn-2",
      provider: "minimax",
      authType: "apikey",
      isActive: true,
      providerSpecificData: {},
    });

    const req = makeModelsRequest("minimax", "effective");
    const res = await getProviderModels(req, {
      params: Promise.resolve({ provider: "minimax" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.models.map((m) => m.id);
    expect(ids).not.toContain("MiniMax-M2");
  });
});

// ========================================================================
// Compatible provider instances — not included without explicit mode
// ========================================================================

describe("compatible provider instances", () => {
  beforeEach(() => {
    resetMockData();
    vi.clearAllMocks();
  });

  it("compatible provider connections are not returned in default effective source", async () => {
    // A connection from a different provider should not appear in minimax results
    mockConnections.push({
      id: "other-conn",
      provider: "openai", // not minimax
      authType: "apikey",
      isActive: true,
      providerSpecificData: {},
    });

    const req = makeModelsRequest("minimax", "effective");
    const res = await getProviderModels(req, {
      params: Promise.resolve({ provider: "minimax" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // No models from openai connection should appear
    for (const m of body.models) {
      expect(m.publicId).toMatch(/^minimax\//);
    }
  });
});

// ========================================================================
// includeCompatible=true — openai-compatible / anthropic-compatible nodes
// ========================================================================

describe("includeCompatible=true", () => {
  beforeEach(() => {
    resetMockData();
    vi.clearAllMocks();
  });

  it("returns 404 for compatible-node prefix without includeCompatible", async () => {
    mockNodes.push({
      id: "openai-compatible-chat-abc",
      type: "openai-compatible",
      prefix: "myllm",
      apiType: "chat",
      baseUrl: "https://example.com/v1",
      name: "MyLLM",
    });

    const req = makeModelsRequest("myllm", "effective");
    const res = await getProviderModels(req, {
      params: Promise.resolve({ provider: "myllm" }),
    });
    expect(res.status).toBe(404);
  });

  it("resolves compatible-node by prefix and returns nodeType", async () => {
    mockNodes.push({
      id: "openai-compatible-chat-abc",
      type: "openai-compatible",
      prefix: "myllm",
      apiType: "chat",
      baseUrl: "https://example.com/v1",
      name: "MyLLM",
    });
    mockConnections.push({
      id: "conn-mylllm",
      provider: "openai-compatible-chat-abc",
      authType: "apikey",
      isActive: true,
      providerSpecificData: {
        prefix: "myllm",
        baseUrl: "https://example.com/v1",
        enabledModels: ["gpt-foo"],
      },
    });

    const req = makeModelsRequest("myllm", "effective", { includeCompatible: true });
    const res = await getProviderModels(req, {
      params: Promise.resolve({ provider: "myllm" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.provider).toBe("openai-compatible-chat-abc");
    expect(body.alias).toBe("myllm");
    expect(body.nodeType).toBe("openai-compatible");
    expect(body.models.map((m) => m.id)).toEqual(["gpt-foo"]);
    expect(body.models[0].publicId).toBe("myllm/gpt-foo");
  });

  it("prefix matching is case-insensitive", async () => {
    mockNodes.push({
      id: "openai-compatible-chat-xyz",
      type: "openai-compatible",
      prefix: "MyLLM",
      apiType: "chat",
      baseUrl: "https://example.com/v1",
      name: "MyLLM",
    });
    mockConnections.push({
      id: "conn-1",
      provider: "openai-compatible-chat-xyz",
      authType: "apikey",
      isActive: true,
      providerSpecificData: { prefix: "MyLLM", enabledModels: ["gpt-x"] },
    });

    const req = makeModelsRequest("MYLLM", "effective", { includeCompatible: true });
    const res = await getProviderModels(req, {
      params: Promise.resolve({ provider: "MYLLM" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.provider).toBe("openai-compatible-chat-xyz");
  });

  it("source=static for compatible node returns empty models with warning", async () => {
    mockNodes.push({
      id: "openai-compatible-chat-abc",
      type: "openai-compatible",
      prefix: "myllm",
      apiType: "chat",
      baseUrl: "https://example.com/v1",
      name: "MyLLM",
    });

    const req = makeModelsRequest("myllm", "static", { includeCompatible: true });
    const res = await getProviderModels(req, {
      params: Promise.resolve({ provider: "myllm" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.models).toEqual([]);
    expect(body.warning).toMatch(/Compatible node has no static catalog/);
    expect(body.nodeType).toBe("openai-compatible");
  });

  it("source=dynamic invokes fetchProviderModelsForConnection for openai-compatible", async () => {
    const { fetchProviderModelsForConnection } = await import(
      "../../src/app/api/providers/[id]/models/route.js"
    );
    fetchProviderModelsForConnection.mockResolvedValueOnce({
      provider: "openai-compatible-chat-abc",
      connectionId: "conn-1",
      models: [{ id: "gpt-upstream", name: "GPT Upstream" }],
    });

    mockNodes.push({
      id: "openai-compatible-chat-abc",
      type: "openai-compatible",
      prefix: "myllm",
      apiType: "chat",
      baseUrl: "https://example.com/v1",
      name: "MyLLM",
    });
    mockConnections.push({
      id: "conn-1",
      provider: "openai-compatible-chat-abc",
      authType: "apikey",
      isActive: true,
      providerSpecificData: { prefix: "myllm", baseUrl: "https://example.com/v1" },
      apiKey: "test-key",
    });

    const req = makeModelsRequest("myllm", "dynamic", { includeCompatible: true });
    const res = await getProviderModels(req, {
      params: Promise.resolve({ provider: "myllm" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("dynamic");
    expect(body.nodeType).toBe("openai-compatible");
    expect(body.models.map((m) => m.id)).toEqual(["gpt-upstream"]);
    expect(body.models[0].publicId).toBe("myllm/gpt-upstream");
    expect(fetchProviderModelsForConnection).toHaveBeenCalledTimes(1);
  });

  it("returns 409 on prefix collision", async () => {
    mockNodes.push(
      {
        id: "openai-compatible-chat-aaa",
        type: "openai-compatible",
        prefix: "shared",
        apiType: "chat",
        baseUrl: "https://a.example.com/v1",
        name: "A",
      },
      {
        id: "openai-compatible-chat-bbb",
        type: "openai-compatible",
        prefix: "shared",
        apiType: "chat",
        baseUrl: "https://b.example.com/v1",
        name: "B",
      },
    );

    const req = makeModelsRequest("shared", "effective", { includeCompatible: true });
    const res = await getProviderModels(req, {
      params: Promise.resolve({ provider: "shared" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/Ambiguous/);
  });

  it("returns 404 with embeddings hint for custom-embedding prefix", async () => {
    mockNodes.push({
      id: "custom-embedding-zzz",
      type: "custom-embedding",
      prefix: "myemb",
      baseUrl: "https://emb.example.com/v1",
      name: "MyEmb",
    });

    const req = makeModelsRequest("myemb", "effective", { includeCompatible: true });
    const res = await getProviderModels(req, {
      params: Promise.resolve({ provider: "myemb" }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/embeddings/i);
  });

  it("canonical providers still resolve with includeCompatible=true", async () => {
    // Even if there's a compatible node, canonical id must win
    mockNodes.push({
      id: "openai-compatible-chat-zzz",
      type: "openai-compatible",
      prefix: "minimax",
      apiType: "chat",
      baseUrl: "https://shadow.example.com/v1",
      name: "Shadow",
    });

    const req = makeModelsRequest("minimax", "static", { includeCompatible: true });
    const res = await getProviderModels(req, {
      params: Promise.resolve({ provider: "minimax" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.provider).toBe("minimax");
    expect(body.nodeType).toBeUndefined();
    expect(body.models.length).toBeGreaterThan(0);
  });
});
