// The 429 message has now been wrong twice, in opposite directions, and each version cost
// real debugging time. These tests exist so it cannot quietly drift back into asserting a
// cause nobody measured.
//
//   v1 — "TPM rate-limited (per-minute window) — daily quota healthy, retries in ~90s".
//        Read as a benign hiccup, so every investigation went to the provider dashboard, saw
//        100% of the 5-hour quota, and concluded the message was impossible.
//   v2 — "…a single large request can consume a whole minute's window; send fewer tools".
//        It swapped a vague message for a confident wrong one. Measurement contradicted it:
//        a 166 KB / 189-tool request succeeds five times in a row, while the failure actually
//        captured (`_originalSize: 93944`, 38 tools — smaller by every measure) was refused.
//        Shrinking the request did not fix anything; the streak gate plus a 10s park did.
//
// What the message is allowed to assert: the 429 is Google's per-minute budget, that budget
// is tracked separately from the daily/5-hour quota, and the latter will keep reading 100%.
// What it must NOT assert: that request size explains it.
import { describe, expect, it } from "vitest";
import {
  classify429,
  describeTpmExhaustion,
} from "../../open-sse/services/antigravity429Engine.js";

describe("classify429 — Google's ambiguous quota body", () => {
  it("treats 'Resource has been exhausted' as quota_exhausted, not a soft rate limit", () => {
    // Google sends this same body for both the daily bucket and the per-minute bucket.
    // Classifying it softly is what allowed the picker to retry a single account in a
    // tight loop and to describe the result as a mere TPM hiccup.
    expect(classify429("Resource has been exhausted (e.g. check quota).")).toBe("quota_exhausted");
  });
});

describe("describeTpmExhaustion", () => {
  it("reports the request shape as a fact", () => {
    // The production shape: tiny prompt, 189 tool declarations, large input.
    const message = describeTpmExhaustion({
      inputTokens: 93600,
      promptChars: 6,            // "Привет"
      toolCount: 189,
      retryAfterMs: 10_000,
    });

    // The prompt really was one word; the request really was not. Both belong in the line.
    expect(message).toContain("93600");
    expect(message).toContain("189");
    expect(message).toContain("6 chars of prompt");
    expect(message).toContain("10s");
  });

  it("never says request size caused the 429", () => {
    // The v2 wording. Reintroducing it is a regression even though it sounds plausible:
    // equally large requests succeed on the same account, so size does not predict the 429.
    const message = describeTpmExhaustion({
      inputTokens: 93600,
      promptChars: 6,
      toolCount: 189,
      retryAfterMs: 10_000,
    });

    expect(message).not.toMatch(/send fewer tools/i);
    expect(message).not.toMatch(/consume a whole minute/i);
    expect(message).not.toMatch(/single large request/i);
    // …and it should say outright that size was not shown to matter, so nobody trims tools
    // chasing a cause that was never demonstrated.
    expect(message).toMatch(/size has not been shown/i);
  });

  it("does not blame tools when there were none", () => {
    const message = describeTpmExhaustion({
      inputTokens: 210_000,
      promptChars: 400_000,
      toolCount: 0,
      retryAfterMs: 45_000,
    });

    expect(message).toContain("210000");
    expect(message).toContain("400k chars of prompt");
    expect(message).not.toContain("189");
    expect(message).not.toMatch(/0 tools/);
  });

  it("still says something useful when the payload composition is unknown", () => {
    // No instrumentation available (older node, non-Antigravity provider): the message must
    // stay a plain rate-limit note rather than invent a cause.
    const message = describeTpmExhaustion({ inputTokens: null, promptChars: null, toolCount: null, retryAfterMs: 60_000 });

    expect(message).toMatch(/per-minute/i);
    expect(message).not.toMatch(/request:/);
  });

  it("distinguishes the per-minute window from the daily quota in so many words", () => {
    // The operator needs to know these are different budgets, because the dashboard only
    // shows the daily/5-hour one and will keep looking healthy.
    const message = describeTpmExhaustion({ inputTokens: 300_000, promptChars: 10, toolCount: 40, retryAfterMs: 30_000 });

    expect(message).toMatch(/per-minute/i);
    expect(message).toMatch(/daily|5-hour/i);
    expect(message).toMatch(/100%/);
  });
});
