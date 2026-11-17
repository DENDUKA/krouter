/**
 * 0.5.169 — the Antigravity roster. Why every Gemini chat id returned 404.
 *
 * Two separate halves were missing, which is why the symptom survived a version that
 * believed it had fixed it:
 *   - the 3.8 entries carried NO `upstreamModelId`, so getModelUpstreamId returned the id
 *     unchanged and the catalog id went to Google verbatim;
 *   - `getModelThinkingLevel`, added in 0.5.166 for exactly this ladder, was called from
 *     nowhere, so even a correct wire id would have dropped the tier.
 * The Antigravity executor now reads both.
 *
 * Antigravity collapses each flash family to ONE tiered id and takes the tier in
 * generationConfig.thinkingConfig. Proven with a direct call to Google for a real account:
 *
 *   POST v1internal:generateContent  model=gemini-3.8-flash-tiered  -> 200
 *   POST v1internal:generateContent  model=gemini-3.8-flash-high    -> 404 NOT_FOUND
 *
 * and v1internal:fetchAvailableModels for that account serves `gemini-3.8-flash-tiered` at
 * remainingFraction 1.0 while serving no id named `-high`/`-medium`/`-low`. Of the 25 ag ids
 * kRouter advertised, 15 were not served and 12 served ids were not advertised at all.
 *
 * The roster is server-side dynamic — it flips with experimentIds, and two captures of the
 * same account minutes apart differed — so the fixture here is a snapshot of one arm, not a
 * contract. Its job is to make drift fail a test instead of reaching users as a 404.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { PROVIDER_MODELS, getModelUpstreamId, getModelThinkingLevel } from "../../open-sse/config/providerModels.js";
import { openaiToAntigravityRequest } from "../../open-sse/translator/request/openai-to-gemini.js";

const roster = JSON.parse(readFileSync("tests/fixtures/antigravity-live-roster.json", "utf8"));
const served = new Set(roster.servedModelIds);
const ag = PROVIDER_MODELS.ag || [];
const upstreamOf = (m) => m.upstreamModelId || m.id;

describe("the tiered families resolve to the id Google serves", () => {
  it.each([
    ["gemini-3.8-flash-high", "high"],
    ["gemini-3.8-flash-medium", "medium"],
    ["gemini-3.8-flash-low", "low"],
  ])("%s -> gemini-3.8-flash-tiered with thinkingLevel %s", (id, level) => {
    expect(getModelUpstreamId("ag", id)).toBe("gemini-3.8-flash-tiered");
    expect(getModelThinkingLevel("ag", id)).toBe(level);
  });

  it("the tiered upstream is one the live roster actually serves", () => {
    expect(served.has("gemini-3.8-flash-tiered")).toBe(true);
  });

  it("the shared -tiered upstream is the shape the catalog relies on, whether or not the arm also serves the tiers", () => {
    // 2026-11-17 — this assertion used to claim the 3.8 tier ids were NOT served at all,
    // which was true for the roster the pre-2.32.1 User-Agent produced. The arm the real
    // app UA reveals serves BOTH the distinct tiers and `gemini-3.8-flash-tiered`, so the
    // claim no longer holds as written. What still matters — and all the catalog depends
    // on — is that the -tiered upstream answers, because that is what the tiers are mapped
    // onto; an arm that only serves -tiered must keep working. Verified live across both
    // arms: `...  model=gemini-3.8-flash-tiered  -> 200`.
    expect(served.has("gemini-3.8-flash-tiered")).toBe(true);
  });

  it("an id with no mapping is passed through untouched", () => {
    expect(getModelUpstreamId("ag", "gemini-3-flash")).toBe("gemini-3-flash");
    expect(getModelThinkingLevel("ag", "gemini-3-flash")).toBeNull();
  });

  it("an id absent from the catalog is passed through rather than invented", () => {
    // Anything arriving through MITM is an upstream id already.
    expect(getModelUpstreamId("ag", "no-such-model")).toBe("no-such-model");
    expect(getModelThinkingLevel("ag", "no-such-model")).toBeNull();
  });

  it("the executor is what reads them — the halves that were missing", () => {
    const src = readFileSync("open-sse/executors/antigravity.js", "utf8");
    expect(src).toContain('getModelUpstreamId("ag", model)');
    expect(src).toContain('getModelThinkingLevel("ag", model)');
  });
});

describe("the request that goes upstream carries both", () => {
  const build = (model, body = {}) =>
    openaiToAntigravityRequest(model, { messages: [{ role: "user", content: "hi" }], ...body }, false, { projectId: "p" });

  it("sends the tiered id, not the catalog id", () => {
    expect(build("gemini-3.8-flash-high").model).toBe("gemini-3.8-flash-tiered");
  });

  it("puts the tier the id encoded into thinkingConfig", () => {
    const env = build("gemini-3.8-flash-low");
    expect(env.request.generationConfig.thinkingConfig).toEqual({
      thinkingLevel: "low",
      includeThoughts: true,
    });
  });

  it("an explicit reasoning_effort in the request still wins", () => {
    // The caller asked for something specific; the id's tier is only a default.
    const env = build("gemini-3.8-flash-high", { reasoning_effort: "low" });
    expect(env.request.generationConfig.thinkingConfig.thinkingLevel).toBe("low");
  });

  it("a non-tiered Gemini id keeps its own name and gains no thinkingConfig", () => {
    const env = build("gemini-3-flash");
    expect(env.model).toBe("gemini-3-flash");
    expect(env.request.generationConfig.thinkingConfig).toBeUndefined();
  });

  it("the Claude path is unaffected — those tiers are served as distinct ids", () => {
    expect(build("claude-sonnet-5-5-high").model).toBe("claude-sonnet-5-5-high");
  });
});

describe("the catalog is measured against the live roster", () => {
  // Ids this account's arm does not serve. Kept in the catalog on purpose: the roster is
  // an experiment-arm thing, a user may have a saved combo or alias pointing at one, and
  // a request for one now fails fast with an honest 404 (see parked-account-status).
  // 2026-11-17 — `gemini-4-argon-high` moved OUT of this set: the roster was only ever
  // truncated because kRouter sent the pre-2.32.1 User-Agent. With the real app UA the
  // endpoint serves all three Argon tiers and all four Hydrogen tiers.
  const KNOWN_UNSERVED = new Set([
    "gemini-3.7-flash-high", "gemini-3.7-flash-medium", "gemini-3.7-flash-low",
    "gemini-3.6-flash-high", "gemini-3.6-flash-medium", "gemini-3.6-flash-low",
    "gemini-3.1-pro-high", "gemini-pro-agent", "gemini-3.1-pro-low",
    "claude-sonnet-4-6", "claude-opus-4-6-thinking",
  ]);

  it("every catalog id is either served or listed as a known-unserved id", () => {
    const surprises = ag
      .filter((m) => !served.has(upstreamOf(m)) && !KNOWN_UNSERVED.has(m.id))
      .map((m) => `${m.id} -> ${upstreamOf(m)}`);
    expect(surprises).toEqual([]);
  });

  it("the ids the roster serves as chat models are published", () => {
    // chat_*/tab_* are tab-completion lanes; -tiered is a shared upstream, not a user
    // choice; -disabled is Google's placeholder for a model the arm has switched off
    // (it is served with quotaInfo: null and 404s on generateContent). None of those
    // belong in the picker.
    const isUserFacing = (id) =>
      !id.startsWith("chat_") &&
      !id.startsWith("tab_") &&
      !id.includes("-tiered") &&
      !id.endsWith("-disabled") &&
      // This arm serves the 3.8 tiers twice: as distinct ids and as the shared -tiered
      // upstream the catalog maps them onto. Both work; publishing the -tiered mapping
      // is the shape that survives an arm that only serves -tiered.
      !/^gemini-3\.\d-flash-(high|medium|low)$/.test(id);
    const published = new Set(ag.map(upstreamOf));
    const missing = roster.servedModelIds.filter((id) => isUserFacing(id) && !published.has(id));
    expect(missing).toEqual([]);
  });

  it("the ids added in 0.5.169 are the ones the roster serves", () => {
    const ids = new Set(ag.map((m) => m.id));
    for (const id of [
      "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-flash-thinking",
      "gemini-2.5-pro", "gemini-3-flash", "gemini-3.1-flash-lite", "gemini-3.5-flash-lite",
    ]) {
      expect(ids.has(id)).toBe(true);
      expect(served.has(id)).toBe(true);
    }
  });

  it("the fixture is a real capture, not an empty stub", () => {
    expect(roster.servedModelIds.length).toBeGreaterThan(10);
    expect(roster.experimentIdCount).toBeGreaterThan(0);
  });
});
