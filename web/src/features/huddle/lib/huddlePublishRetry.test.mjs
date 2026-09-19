import assert from "node:assert/strict";
import { test } from "node:test";

const {
  DEFAULT_RATE_LIMIT_RETRIES,
  MIN_RATE_LIMIT_RETRY_MS,
  publishWithRateLimitRetry,
  rateLimitRetryDelayMs,
} = await import("./huddlePublishRetry.ts");

test("rate-limit parsing honors the server reset and floors zero", () => {
  assert.equal(
    rateLimitRetryDelayMs("rate-limited: quota exceeded; retry in 2s"),
    2000,
  );
  assert.equal(
    rateLimitRetryDelayMs("rate-limited: quota exceeded; retry in 0s"),
    MIN_RATE_LIMIT_RETRY_MS,
  );
  assert.equal(
    rateLimitRetryDelayMs("rate-limited: quota exceeded"),
    MIN_RATE_LIMIT_RETRY_MS,
  );
  assert.equal(rateLimitRetryDelayMs("rate-limited: retry in 99s"), null);
  assert.equal(rateLimitRetryDelayMs("permission denied"), null);
});

test("a direct retry republishes the same signed event after the reset", async () => {
  const event = { id: "signed-once" };
  const seen = [];
  const delays = [];
  let attempt = 0;
  const result = await publishWithRateLimitRetry(
    async (candidate) => {
      seen.push(candidate);
      attempt += 1;
      return attempt === 1
        ? { ok: false, message: "rate-limited: retry in 2s" }
        : { ok: true, message: "accepted" };
    },
    event,
    {
      enabled: true,
      sleep: async (delayMs) => delays.push(delayMs),
    },
  );

  assert.deepEqual(result, { ok: true, message: "accepted" });
  assert.equal(attempt, 2);
  assert.equal(seen[0], event);
  assert.equal(seen[1], event);
  assert.deepEqual(delays, [2000]);
});

test("terminal refusal is not retried and quota exhaustion stays visible", async () => {
  let terminalAttempts = 0;
  const terminal = await publishWithRateLimitRetry(
    async () => {
      terminalAttempts += 1;
      return { ok: false, message: "membership refused" };
    },
    { id: "terminal" },
    { enabled: true, sleep: async () => {} },
  );
  assert.equal(terminalAttempts, 1);
  assert.equal(terminal.ok, false);

  let quotaAttempts = 0;
  const quota = await publishWithRateLimitRetry(
    async () => {
      quotaAttempts += 1;
      return { ok: false, message: "rate-limited: retry in 0s" };
    },
    { id: "quota" },
    { enabled: true, sleep: async () => {} },
  );
  assert.equal(quotaAttempts, DEFAULT_RATE_LIMIT_RETRIES + 1);
  assert.match(quota.message, /rate-limited/);
});

test("cancellation stops before a retry publish", async () => {
  let active = true;
  let attempts = 0;
  const result = await publishWithRateLimitRetry(
    async () => {
      attempts += 1;
      active = false;
      return { ok: false, message: "rate-limited: retry in 2s" };
    },
    { id: "cancel" },
    {
      enabled: true,
      shouldContinue: () => active,
      sleep: async () => {},
    },
  );
  assert.equal(attempts, 1);
  assert.deepEqual(result, {
    ok: false,
    message: "The call request was cancelled.",
  });
});
