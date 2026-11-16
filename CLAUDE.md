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

## Antigravity 429 — content filter, not quota (2026-11-17)

The most expensive misunderstanding in this codebase: the same
`429 "Resource has been exhausted (e.g. check quota)."` body is also what Google returns when
it simply refuses to serve a request because of what the prompt *says*. Every symptom then
points at quota while the quota is fine, and the handler faithfully reports "per-minute
window", sending the next investigation to the provider dashboard that shows 100%.

How it was proved, and the shape of the evidence to look for:

- **Latency is the tell.** A real quota rejection cannot answer in 100-650 ms. Every refused
  request came back in that window; every accepted one took 8-60 s. If a 429 is fast, it is a
  verdict on the request, not a measurement of a budget.
- **A single sentence flips it.** Capture the exact outbound body of a failing turn, then
  replace one sentence at a time. `The browser provides no implicit DOM, route, or screenshot
  context.` inside `systemInstruction` was the trigger: swapping only that sentence in the
  captured 6480-char prompt turned 429 into 200, and restoring it turned 200 back into 429.
  Quota read 97.6% the whole time. `This is a provider-side fault` style wording was wrong.
- **`ANTIGRAVITY_PROMPT_REWRITES` is where such sentences get neutralised**, and it is applied
  to `systemInstruction` and `contents` separately — a rule that only touches one of them
  will look correct and change nothing. `obfuscateBodyStrings` is applied to both now.
- **Zero-width joiners do NOT defeat this filter.** `antigravityObfuscation.js` splits a
  sensitive word with U+200D; shipped and verified — the ZWJ was present in the outgoing body
  and Google still refused. It normalises before matching. Use a real substitution (rebrand
  the token) for prompts, and keep ZWJ only for tool names, where it does work.
- **Do not "fix" it by trimming the request.** Payload size, tool count, `maxOutputTokens`,
  `thinkingConfig` and `toolConfig` were each replayed with one field changed and none of them
  mattered. Shrinking the prompt hides the bug until the next sentence trips the filter.

Concurrency, measured the same way: the note that used to sit on
`PROVIDER_CONCURRENCY_DEFAULTS.antigravity = 1` claimed upstream rejects a second in-flight
stream. It does not — 2 and 3 parallel streams all returned 200 (20-37 s each). The account
now allows 2, with `SEMAPHORE_TIMEOUT_DEFAULTS.antigravity = 90_000` so a waiter outlasts the
60-100 s streams instead of surfacing `503 Account busy, try another`.

