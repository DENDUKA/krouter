// The "TPM rate-limited" narrative was wrong, and it sent every investigation down the
// wrong path — including into the provider's dashboard, which showed 100% of a 5-hour quota
// and made the message look impossible.
//
// What actually happens: Antigravity enforces a per-MINUTE *token* window per account, and
// dsh sends very large requests — 189 tool declarations, 1.4–1.6 MB of JSON, measured at up
// to 747,349 input tokens on a single call. One such call can consume an entire minute's
// token budget, so the *next* call within that minute gets Google's 429
// "Resource has been exhausted (e.g. check quota)". The daily/5-hour quota really is
// untouched — which is exactly why the operator's dashboard said 100% healthy.
//
// The old message asserted a TPM window and "daily quota healthy" as if that were a benign
// throttle, never mentioning that the request itself was enormous. "I only sent Привет" was
// a fair objection: the prompt was one word, the request was 189 tools.
//
// These tests pin the message to the evidence actually available: the prompt really is tiny,
// the tools are really the payload, and the wording must say so.
import { describe, expect, it } from "vitest";
import {
  classify429,
  describeTpmExhaustion,
} from "../../open-sse/services/antigravity429Engine.js";

describe("classify429 — Google's ambiguous quota body", () => {
  it("treats 'Resource has been exhausted' as quota_exhausted, not a soft rate limit", () => {
    // Google sends this same body for both the daily bucket and the per-minute bucket.
    // Classifying it softly is what allowed the picker to retry a single account in a
    // tight loop and to describe the result as a mere 90-second TPM hiccup.
    expect(classify429("Resource has been exhausted (e.g. check quota).")).toBe("quota_exhausted");
  });
});

describe("describeTpmExhaustion", () => {
  it("names the tools as the payload when they dominate the request", () => {
    // The production shape: tiny prompt, 189 tool declarations, huge input.
    const message = describeTpmExhaustion({
      inputTokens: 747349,
      promptChars: 6,            // "Привет"
      toolCount: 189,
      retryAfterMs: 90_000,
    });

    expect(message).toContain("747349");
    expect(message).toContain("189");
    // The whole point: stop claiming the request was small.
    expect(message).toMatch(/tools/i);
    expect(message).not.toMatch(/^\[antigravity\/[^\]]+\] TPM rate-limited \(per-minute window\) — daily quota healthy, retries in ~90s$/);
  });

  it("does not blame tools when there were none", () => {
    const message = describeTpmExhaustion({
      inputTokens: 210_000,
      promptChars: 400_000,
      toolCount: 0,
      retryAfterMs: 45_000,
    });

    expect(message).toContain("210000");
    expect(message).toMatch(/prompt|context/i);
    expect(message).not.toMatch(/189/);
  });

  it("still says something useful when the payload composition is unknown", () => {
    // No instrumentation available (older node, non-Antigravity provider): the message must
    // stay a plain rate-limit note rather than invent a cause.
    const message = describeTpmExhaustion({ inputTokens: null, promptChars: null, toolCount: null, retryAfterMs: 60_000 });

    expect(message).toMatch(/per-minute/i);
    expect(message).toMatch(/token/i);
  });

  it("distinguishes the per-minute window from the daily quota in so many words", () => {
    // The operator needs to know these are different budgets, because the dashboard only
    // shows the daily/5-hour one and will keep looking healthy.
    const message = describeTpmExhaustion({ inputTokens: 300_000, promptChars: 10, toolCount: 40, retryAfterMs: 30_000 });

    expect(message).toMatch(/per-minute/i);
    expect(message).toMatch(/daily|5-hour|quota/i);
  });
});
