@AGENTS.md

## Antigravity 429 — per-minute window, streak gate, short park

`open-sse/services/antigravity429Engine.js` + `src/sse/services/auth.js` classify and react
to Google's `429 "Resource has been exhausted (e.g. check quota)."`.

- **The 429 is the per-minute (TPM) token window, not the daily/5-hour quota.** The provider
  dashboard keeps showing 100% and that is not a contradiction — `fetchAvailableModels`
  reports the daily budget only, while the chat endpoint enforces a separate per-minute cap
  with the same body for both. `isAccountAboveThreshold(..., 10)` re-checks the cached daily
  quota precisely to tell them apart; keep that check, it is the whole disambiguation.
- **A lone 429 is a blip, not a spent window.** `recordRateLimitHit` / `shouldLockForRateLimit`
  require `RATE_LIMIT_STREAK_THRESHOLD` (5) hits inside `RATE_LIMIT_STREAK_WINDOW_MS` (2 min).
  Below the threshold the handler returns no cooldown at all — the request goes back to Google,
  which is the only authority. Locking on the first 429 turned one upstream rejection into a
  wave of local ones: every later caller hit the lock and replayed the same text as if Google
  had said it. Any success calls `resetRateLimitStreak` — proof the window is free again.
- **The park is `TPM_COOLDOWN_MS = 10 * 1000`, deliberately short** (was 90s). The streak has
  already proven a real burst; Google's minute bucket drains continuously rather than at a hard
  boundary, so 90s kept the account idle past the point it would have answered. Ten seconds
  lets the in-flight burst settle; if the window is still closed the next attempt re-enters
  the streak and parks again — self-correcting, no manual tuning.
- **Keep `describeTpmExhaustion` honest about the payload.** It must name what the request
  carried (input tokens / tool count / prompt size) and say outright that the daily quota will
  look healthy. The old wording read as a benign hiccup, so every investigation went to the
  provider dashboard, saw 100%, and concluded the message was impossible.
- Tests pin all of this: `tests/unit/antigravity-ratelimit-streak.test.js` (streak semantics
  and the `10 * 1000` literal), `antigravity-tpm-message-is-honest.test.js`,
  `precise-reset-beats-tpm-downgrade.test.js`. They are **vitest** — `node --test` reports the
  file as failing with a bogus `Cannot read properties of undefined (reading 'config')`.

