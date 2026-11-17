// antigravity429Engine (0.5.29) — port of OmniRoute's antigravity429Engine.
//
// Classifies Google's 429 responses into 4 categories so the caller can
// make a nuanced retry decision instead of "exponential backoff every time".
//
// Categories:
//   unknown          → generic 429, default backoff
//   soft_rate_limit  → burst limit, instant retry on same auth
//   rate_limited     → RPM cap, short backoff or switch auth if long
//   quota_exhausted  → daily/plan quota gone, skip this account ~5h–24h
//
// Decisions (kind):
//   instant_retry_same_auth     wait ≤3s and retry
//   soft_retry                  short wait, retry same auth
//   short_cooldown_switch_auth  ~5min lock, rotate accounts
//   full_quota_exhausted        long lock, skip this account
//
// Pure functions — no I/O, no globals (except a per-process credits-failure
// counter that's used by the optional auto-disable feature).

const QUOTA_EXHAUSTED_KEYWORDS = [
  "quota_exhausted",
  "quota exhausted",
  "quota reached",
  "enable overages",
  "individual quota",
];

const CREDITS_EXHAUSTED_KEYWORDS = [
  "google_one_ai",
  "insufficient credit",
  "insufficient credits",
  "not enough credit",
  "not enough credits",
  "credit exhausted",
  "credits exhausted",
  "credit balance",
  "minimumcreditamountforusage",
  "minimum credit amount for usage",
  "minimum credit",
  "resource has been exhausted",
];

const SHORT_COOLDOWN_MS = 5 * 60 * 1000;

// 2026-11-18 — 30min → 20s. Google's `Resource has been exhausted (e.g. check quota)`
// on Antigravity is NOT proof that the daily quota is gone. Measured on the prod
// account: the dashboard read 100% on every bucket while the router kept answering
// 503, and clearing modelLock_gemini-4-hydrogen-medium from the connection made the
// very next request return 200 in under a second. The message is the same body Google
// ships for the per-minute window, and `parseRetryFromErrorMessage` cannot extract a
// delay from it (no "resets in" phrase, no bare duration), so it used to fall through
// to this constant.
//
// At 30 minutes one blip parked every Gemini-4 model — the whole curated roster shares
// a single antigravity connection — for half an hour, which read as "the site is down"
// while the upstream was healthy. Twenty seconds is longer than the 10s TPM park below
// (this path means a real 429 came back, not a suspected burst) and short enough that a
// genuinely dead window is retried within the same minute instead of being written off.
// Override with ANTIGRAVITY_QUOTA_COOLDOWN_MS when a real multi-hour exhaustion appears.
const DEFAULT_QUOTA_COOLDOWN_MS = 20 * 1000;
const FULL_QUOTA_COOLDOWN_MS = (() => {
  // `typeof process` guard: this module is also pulled into the dashboard graph, where
  // a bare process.env would throw in the browser anyway.
  const env = typeof process !== "undefined" ? Number(process.env?.ANTIGRAVITY_QUOTA_COOLDOWN_MS) : NaN;
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_QUOTA_COOLDOWN_MS;
})();
const INSTANT_RETRY_THRESHOLD_MS = 3 * 1000;

export function classify429(errorMessage) {
  const lower = (errorMessage || "").toLowerCase();
  for (const kw of QUOTA_EXHAUSTED_KEYWORDS) if (lower.includes(kw)) return "quota_exhausted";
  for (const kw of CREDITS_EXHAUSTED_KEYWORDS) if (lower.includes(kw)) return "quota_exhausted";

  if (
    lower.includes("per minute") ||
    lower.includes("rpm") ||
    lower.includes("rate limit") ||
    lower.includes("rate_limit") ||
    lower.includes("too many requests")
  ) {
    return "rate_limited";
  }

  if (
    lower.includes("free tier") ||
    lower.includes("daily limit") ||
    lower.includes("exhausted your capacity")
  ) {
    return "quota_exhausted";
  }

  if (lower.includes("try again") || lower.includes("temporarily")) {
    return "soft_rate_limit";
  }

  return "unknown";
}

export function decide429(category, retryAfterMs) {
  switch (category) {
    case "soft_rate_limit":
      return {
        kind: retryAfterMs && retryAfterMs <= INSTANT_RETRY_THRESHOLD_MS
          ? "instant_retry_same_auth"
          : "soft_retry",
        retryAfterMs: retryAfterMs ?? 2000,
        reason: "Soft rate limit — brief backoff",
      };

    case "rate_limited":
      return {
        kind: retryAfterMs && retryAfterMs <= SHORT_COOLDOWN_MS
          ? "soft_retry"
          : "short_cooldown_switch_auth",
        retryAfterMs: retryAfterMs ?? 60_000,
        reason: "RPM rate limit — switch auth if cooldown is long",
      };

    case "quota_exhausted":
      return {
        kind: "full_quota_exhausted",
        retryAfterMs: retryAfterMs ?? FULL_QUOTA_COOLDOWN_MS,
        reason: "Quota exhausted — skip this account",
      };

    default:
      return {
        kind: "soft_retry",
        retryAfterMs: retryAfterMs ?? 5000,
        reason: "Unknown 429 — generic backoff",
      };
  }
}

// Human-readable explanation for a 429 that the daily-quota cache says should not happen.
//
// History matters here, because this string was wrong twice and each version sent debugging
// down a blind alley:
//
//   v1 — "TPM rate-limited (per-minute window) — daily quota healthy, retries in ~90s".
//        Read as a benign hiccup on a healthy account, so every investigation opened the
//        provider dashboard, saw 100% of the 5-hour quota, and concluded the message was
//        impossible.
//   v2 — "…one large request can consume a whole minute's window; send fewer tools".
//        Asserted a cause that measurement then contradicted: a 166 KB / 189-tool request
//        now succeeds five times in a row, while the failure that was actually captured
//        (`_originalSize: 93944`, 38 tools — smaller by every measure) was refused. Sending
//        a smaller request did not make it pass; the streak gate and a short park did.
//
// So v3 states only what is measured: the per-minute budget is separate from the daily one,
// the daily one will keep showing 100%, the request is documented for the record — and the
// size is explicitly NOT offered as the explanation, because we do not have one.
//
// @param {object} payload
// @param {number|null} payload.inputTokens  tokens Google counted for the request, if known
// @param {number|null} payload.promptChars  characters of the user prompt, if known
// @param {number|null} payload.toolCount    number of tool declarations, if known
// @param {number|null} payload.retryAfterMs time until the window resets, if known
// @returns {string}
export function describeTpmExhaustion({ inputTokens, promptChars, toolCount, retryAfterMs } = {}) {
  // Describe the request as a fact, not as a verdict. This is the shape operators recognise
  // when they correlate the log line with a session, and it is what proves "I only sent
  // Привет" wrong about the *request* without claiming the prompt size caused anything.
  const shape = [];

  if (Number.isFinite(inputTokens) && inputTokens > 0) {
    shape.push(`${Math.round(inputTokens)} input tokens`);
  }
  if (Number.isFinite(toolCount) && toolCount > 0) {
    shape.push(`${toolCount} tools`);
  }
  if (Number.isFinite(promptChars) && promptChars > 0) {
    shape.push(promptChars >= 100_000
      ? `~${Math.round(promptChars / 1000)}k chars of prompt`
      : `${promptChars} chars of prompt`);
  }

  const retry = Number.isFinite(retryAfterMs) && retryAfterMs > 0
    ? `next attempt in ${Math.round(retryAfterMs / 1000)}s`
    : "retrying shortly";

  const detail = shape.length > 0 ? ` (request: ${shape.join(", ")})` : "";

  return `Antigravity refused the request with a 429${detail} — ${retry}. `
    + "Google reports this as the per-minute budget, which is tracked separately from the "
    + "daily/5-hour quota: that one stays at 100% and will keep looking healthy, so it is not "
    + "evidence that the message is wrong. Request size has not been shown to predict this — "
    + "equally large requests succeed — so trim nothing on account of this line.";
}

// Per-connection streak of consecutive 429s, used to decide whether the account deserves a
// lock. A lone 429 is a burst blip that clears in seconds; locking on it costs the whole
// minute for nothing AND turns one upstream rejection into a wave of local ones, because
// every subsequent request hits the lock instead of Google and reports the same text.
//
// The counter is time-windowed rather than a plain increment: 429s spread over an hour are
// independent blips, while five inside a couple of minutes mean the minute bucket really is
// spent. A success clears the streak — proof the window is free again.
const RATE_LIMIT_STREAK_THRESHOLD = 5;
const RATE_LIMIT_STREAK_WINDOW_MS = 2 * 60 * 1000;

const rateLimitStreaks = new Map();

function pruneStreak(connectionId, nowMs) {
  const hits = rateLimitStreaks.get(connectionId);
  if (!hits) return [];
  const fresh = hits.filter((ts) => nowMs - ts <= RATE_LIMIT_STREAK_WINDOW_MS);
  if (fresh.length === 0) rateLimitStreaks.delete(connectionId);
  else rateLimitStreaks.set(connectionId, fresh);
  return fresh;
}

export function recordRateLimitHit(connectionId, nowMs = Date.now()) {
  if (!connectionId) return;
  const fresh = pruneStreak(connectionId, nowMs);
  fresh.push(nowMs);
  rateLimitStreaks.set(connectionId, fresh);
}

export function shouldLockForRateLimit(connectionId, nowMs = Date.now()) {
  if (!connectionId) return false;
  return pruneStreak(connectionId, nowMs).length >= RATE_LIMIT_STREAK_THRESHOLD;
}

export function resetRateLimitStreak(connectionId) {
  if (connectionId) rateLimitStreaks.delete(connectionId);
}

// For tests
export function _clearRateLimitStreaks() { rateLimitStreaks.clear(); }

// Per-account credits failure tracker. After CREDITS_DISABLE_THRESHOLD
// consecutive credits errors, recommend disabling that account for
// CREDITS_COOLDOWN_MS. Reset on any successful call.
const creditsFailureMap = new Map();const CREDITS_DISABLE_THRESHOLD = 3;
const CREDITS_COOLDOWN_MS = 5 * 60 * 60 * 1000;

export function recordCreditsFailure(authKey) {
  if (!authKey) return false;
  const state = creditsFailureMap.get(authKey) ?? { count: 0, disabledUntil: 0 };
  state.count++;
  if (state.count >= CREDITS_DISABLE_THRESHOLD) {
    state.disabledUntil = Date.now() + CREDITS_COOLDOWN_MS;
    creditsFailureMap.set(authKey, state);
    return true;
  }
  creditsFailureMap.set(authKey, state);
  return false;
}

export function isCreditsDisabled(authKey) {
  if (!authKey) return false;
  const state = creditsFailureMap.get(authKey);
  if (!state) return false;
  if (state.disabledUntil > Date.now()) return true;
  creditsFailureMap.delete(authKey);
  return false;
}

export function resetCreditsFailure(authKey) {
  if (authKey) creditsFailureMap.delete(authKey);
}

// For tests
export function _clearCreditsState() { creditsFailureMap.clear(); }
export { SHORT_COOLDOWN_MS, FULL_QUOTA_COOLDOWN_MS, RATE_LIMIT_STREAK_THRESHOLD, RATE_LIMIT_STREAK_WINDOW_MS };
