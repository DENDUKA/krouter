// A single 429 used to lock the account for 90 seconds on the spot. The lock blocks the
// model for EVERY caller, so one unlucky request turned into a wave: the next request never
// reached Google, hit the lock, and reported the same rate-limit text — which is why the
// logs showed three failures per minute that looked like three upstream rejections but were
// really one rejection plus two echoes.
//
// Google's per-minute bucket is bursty and self-healing: a lone 429 is usually gone within
// seconds. Locking on the first one throws away the whole minute for a transient blip. So the
// account is only parked once the failures repeat inside a short window — one or two blips
// pass straight through to a retry, five in a row means the window really is spent.
import { describe, expect, it, beforeEach } from "vitest";
import {
  recordRateLimitHit,
  shouldLockForRateLimit,
  resetRateLimitStreak,
  _clearRateLimitStreaks,
  RATE_LIMIT_STREAK_THRESHOLD,
  RATE_LIMIT_STREAK_WINDOW_MS,
} from "../../open-sse/services/antigravity429Engine.js";

describe("rate-limit streak — the threshold", () => {
  beforeEach(_clearRateLimitStreaks);

  it("requires five consecutive failures, not one", () => {
    expect(RATE_LIMIT_STREAK_THRESHOLD).toBe(5);
  });

  it("does not lock on the first four hits", () => {
    // The whole point: a burst blip must not cost the account a 90-second lock.
    for (let i = 1; i <= 4; i++) {
      recordRateLimitHit("conn-1", 1_000);
      expect(shouldLockForRateLimit("conn-1", 1_000)).toBe(false);
    }
  });

  it("locks on the fifth hit inside the window", () => {
    for (let i = 1; i <= 4; i++) recordRateLimitHit("conn-1", 1_000);
    recordRateLimitHit("conn-1", 1_000);

    expect(shouldLockForRateLimit("conn-1", 1_000)).toBe(true);
  });
});

describe("rate-limit streak — the window", () => {
  beforeEach(_clearRateLimitStreaks);

  it("forgets hits that fall outside the window", () => {
    // Four failures, then a long pause: the burst is over, the counter must not carry it
    // forward or a single later blip would trip the lock.
    for (let i = 0; i < 4; i++) recordRateLimitHit("conn-1", 1_000);

    const later = 1_000 + RATE_LIMIT_STREAK_WINDOW_MS + 1;
    expect(shouldLockForRateLimit("conn-1", later)).toBe(false);

    recordRateLimitHit("conn-1", later);
    expect(shouldLockForRateLimit("conn-1", later)).toBe(false);
  });

  it("keeps hits that are still inside the window", () => {
    for (let i = 0; i < 4; i++) recordRateLimitHit("conn-1", 1_000);
    recordRateLimitHit("conn-1", 1_000 + RATE_LIMIT_STREAK_WINDOW_MS - 1);

    expect(shouldLockForRateLimit("conn-1", 1_000 + RATE_LIMIT_STREAK_WINDOW_MS - 1)).toBe(true);
  });

  it("tracks connections independently", () => {
    // One noisy account must not lock a healthy sibling.
    for (let i = 0; i < 5; i++) recordRateLimitHit("conn-busy", 1_000);

    expect(shouldLockForRateLimit("conn-busy", 1_000)).toBe(true);
    expect(shouldLockForRateLimit("conn-quiet", 1_000)).toBe(false);
  });
});

describe("rate-limit streak — reset on success", () => {
  beforeEach(_clearRateLimitStreaks);

  it("clears the counter after a successful call", () => {
    // A success proves the window is free again; carrying the streak forward would lock the
    // account on the next unrelated blip.
    for (let i = 0; i < 4; i++) recordRateLimitHit("conn-1", 1_000);
    resetRateLimitStreak("conn-1");

    recordRateLimitHit("conn-1", 1_000);
    expect(shouldLockForRateLimit("conn-1", 1_000)).toBe(false);
  });

  it("is safe to reset an unknown connection", () => {
    expect(() => resetRateLimitStreak("never-seen")).not.toThrow();
  });
});
