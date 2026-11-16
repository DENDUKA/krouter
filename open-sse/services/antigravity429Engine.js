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
const FULL_QUOTA_COOLDOWN_MS = 24 * 60 * 60 * 1000;
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
// The previous wording — "TPM rate-limited (per-minute window) — daily quota healthy,
// retries in ~90s" — was technically about the right mechanism but actively misleading, and
// it cost real debugging time. It read as a benign hiccup on a healthy account, so every
// investigation went to the provider dashboard, found 100% of the 5-hour quota and concluded
// the message was impossible. The missing half is that Antigravity's per-minute window is
// measured in TOKENS, and dsh sends enormous ones: 189 tool declarations, 1.4–1.6 MB of JSON,
// measured at up to 747,349 input tokens for a single call. One such call can drain an entire
// minute's budget, so the next call inside that minute is refused — with a one-word prompt.
//
// So the message says what the request actually contained. Saying "your one-word prompt is
// fine, your 189 tool schemas are not" is the difference between a dead end and a fix
// (trim the tool set, or spread calls out).
//
// @param {object} payload
// @param {number|null} payload.inputTokens  tokens Google counted for the request, if known
// @param {number|null} payload.promptChars  characters of the user prompt, if known
// @param {number|null} payload.toolCount    number of tool declarations, if known
// @param {number|null} payload.retryAfterMs time until the window resets, if known
// @returns {string}
export function describeTpmExhaustion({ inputTokens, promptChars, toolCount, retryAfterMs } = {}) {
  const parts = [];

  if (Number.isFinite(inputTokens) && inputTokens > 0) {
    parts.push(`${Math.round(inputTokens)} input tokens`);
  } else {
    parts.push("per-minute token window");
  }

  // Name the payload. Tools win when present because that is what actually fills the request:
  // a 189-tool schema dwarfs any prompt a human types. Only when tools are absent does the
  // prompt itself become the plausible cause.
  if (Number.isFinite(toolCount) && toolCount > 0) {
    parts.push(`${toolCount} tools`);
  } else if (Number.isFinite(promptChars) && promptChars >= 100_000) {
    parts.push(`~${Math.round(promptChars / 1000)}k chars of prompt`);
  }

  const retry = Number.isFinite(retryAfterMs) && retryAfterMs > 0
    ? `resets in ${Math.round(retryAfterMs / 1000)}s`
    : "retry shortly";

  const payload = parts.join(" + ");

  return `Antigravity per-minute token window exhausted (${payload}) — ${retry}. `
    + "This is the per-minute budget, not the daily/5-hour quota: that one stays at 100% and "
    + "will keep looking healthy. A single large request can consume a whole minute's window; "
    + "send fewer tools or space the calls out.";
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
