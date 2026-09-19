/**
 * Small, direct-call-only retry seam for relay admission rate limits.
 *
 * The relay refuses a rate-limited EVENT and never sends an OK for it, so the
 * caller must retry the same signed event after the reset window. Re-signing
 * would create a second event and would make a retry indistinguishable from
 * a duplicate user action.
 */

export const MIN_RATE_LIMIT_RETRY_MS = 1_000;
export const MAX_RATE_LIMIT_RETRY_MS = 10_000;
export const DEFAULT_RATE_LIMIT_RETRIES = 3;

export interface PublishRetryResult {
  ok: boolean;
  message: string;
}

export interface PublishRetryOptions {
  enabled?: boolean;
  maxRetries?: number;
  shouldContinue?: () => boolean;
  sleep?: (delayMs: number) => Promise<void>;
}

/** Parse the relay's reset hint, with a bounded non-zero floor. */
export function rateLimitRetryDelayMs(message: string): number | null {
  if (!/rate-limited/i.test(message)) {
    return null;
  }
  const match = message.match(/retry\s+in\s+(\d+(?:\.\d+)?)s/i);
  const seconds = match ? Number.parseFloat(match[1]) : 0;
  const requested = Number.isFinite(seconds) ? seconds * 1000 : 0;
  // A larger reset must remain visible to the caller. Retrying early would
  // simply burn the bounded attempts and obscure the server's instruction.
  if (requested > MAX_RATE_LIMIT_RETRY_MS) {
    return null;
  }
  return Math.max(MIN_RATE_LIMIT_RETRY_MS, requested);
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, delayMs);
  });
}

/** Publish one already-signed event with bounded, cancellation-aware retries. */
export async function publishWithRateLimitRetry<TEvent>(
  publish: (event: TEvent) => Promise<PublishRetryResult>,
  event: TEvent,
  options: PublishRetryOptions = {},
): Promise<PublishRetryResult> {
  const enabled = options.enabled ?? false;
  const maxRetries = Math.max(
    0,
    Math.floor(options.maxRetries ?? DEFAULT_RATE_LIMIT_RETRIES),
  );
  const shouldContinue = options.shouldContinue ?? (() => true);
  const sleep = options.sleep ?? defaultSleep;
  let retries = 0;

  while (true) {
    if (!shouldContinue()) {
      return { ok: false, message: "The call request was cancelled." };
    }
    const result = await publish(event);
    if (result.ok || !enabled) {
      return result;
    }
    const delayMs = rateLimitRetryDelayMs(result.message);
    if (delayMs === null || retries >= maxRetries) {
      return result;
    }
    retries += 1;
    if (!shouldContinue()) {
      return { ok: false, message: "The call request was cancelled." };
    }
    await sleep(delayMs);
  }
}
