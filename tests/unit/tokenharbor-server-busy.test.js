// Regression: Token Harbor answers 429 with two DIFFERENT bodies, and only one
// of them used to be classified correctly.
//
//   server_busy        — "under heavy load ... slowed down for a few minutes",
//                        type "rate_limit_error" (underscore). A server-load
//                        verdict with a one-minute horizon, and the response
//                        carries `Retry-After: 60`.
//   rate_limit_exceeded — "Rate limit reached ... next request in 42 s".
//                        A per-account limit.
//
// Before the fix the server_busy body matched no text rule: it spells
// "rate_limit_error" with an underscore while the generic rule looks for
// "rate limit" with a space. It therefore fell through to the bare
// `status: 429` rule and locked the account for the 2 s backoff base — a
// sixtieth of what the server asked for. Requests arrive about every 15 s, so
// the same account was re-probed several times before it could recover.
//
// Measured 2026-11-08: 47 of 181 tokenharbor connections had lastError
// containing server_busy, all at backoffLevel 1. Re-testing four of those keys
// directly against the upstream an hour later returned 200 for all of them,
// confirming the throttle is transient and not a dead credential.

import { describe, expect, it } from "vitest";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";
import { ERROR_RULES, BACKOFF_CONFIG } from "../../open-sse/config/errorConfig.js";

const SERVER_BUSY_BODY = JSON.stringify({
  error: {
    message:
      "Token Harbor is under heavy load. Requests from this account are being slowed down for a few minutes; please retry shortly.",
    type: "rate_limit_error",
    code: "server_busy",
  },
});

const PER_ACCOUNT_BODY = JSON.stringify({
  error: {
    message: "Rate limit reached. You can send your next request in 42 s.",
    type: "rate_limit_exceeded",
    code: "rate_limit_exceeded",
  },
});

describe("tokenharbor 429 — server_busy vs per-account rate limit", () => {
  it("locks server_busy for a minute, not the 2s backoff base", () => {
    const result = checkFallbackError(429, SERVER_BUSY_BODY, 0, "tokenharbor");

    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBe(60_000);
  });

  it("keeps the cooldown above the executor backoff ceiling", () => {
    // A `backoff: true` rule would be clamped to BACKOFF_CONFIG.max (30 s),
    // which is still under a request interval's worth of retries. The rule is
    // deliberately a literal cooldownMs so that cap never applies.
    const { cooldownMs } = checkFallbackError(429, SERVER_BUSY_BODY, 0, "tokenharbor");

    expect(cooldownMs).toBeGreaterThan(BACKOFF_CONFIG.max);
  });

  it("does not grow server_busy without bound across repeats", () => {
    // Not a `backoff` rule: repeating the error must not escalate it to the
    // 30 s cap, because the server states the same one-minute horizon each time.
    const first = checkFallbackError(429, SERVER_BUSY_BODY, 0, "tokenharbor");
    const later = checkFallbackError(429, SERVER_BUSY_BODY, 5, "tokenharbor");

    expect(later.cooldownMs).toBe(first.cooldownMs);
    expect(later.newBackoffLevel).toBeUndefined();
  });

  it("still backsoff the per-account rate limit", () => {
    // The per-account body must keep hitting the generic "rate limit" rule and
    // its exponential 2 s base — this fix must not swallow that case.
    const result = checkFallbackError(429, PER_ACCOUNT_BODY, 0, "tokenharbor");

    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBe(BACKOFF_CONFIG.base);
    expect(result.newBackoffLevel).toBe(1);
  });

  it("scopes the rule to tokenharbor", () => {
    // Another provider whose upstream happens to say "under heavy load" must
    // not inherit a 60 s lock from a Token Harbor rule.
    const other = checkFallbackError(429, SERVER_BUSY_BODY, 0, "openai");

    expect(other.cooldownMs).toBeLessThan(60_000);
  });

  it("matches server_busy before the generic rate-limit wording", () => {
    // Order matters: ERROR_RULES is scanned top-to-bottom and the server_busy
    // entry must win even though its body also contains rate-limit vocabulary.
    const idx = (needle) =>
      ERROR_RULES.findIndex((r) => r.provider === "tokenharbor" && r.text === needle);
    const genericIdx = ERROR_RULES.findIndex((r) => r.text === "rate limit");

    expect(idx("server_busy")).toBeGreaterThanOrEqual(0);
    expect(idx("server_busy")).toBeLessThan(genericIdx);
  });
});
