/**
 * Floor gate (voice fast path plan §4.2). Pure, import-free, clock-injected.
 *
 * When an agent reply is about to START playing and the local mic says the
 * caller is talking, playback waits until the mic has been quiet for
 * {@link FLOOR_QUIET_MS}, capped at {@link FLOOR_CAP_MS} from when the reply
 * became due. Sentences inside a reply that is already playing are never
 * gated — only the start. Together with the harness superseding a fast
 * stream when a newer utterance lands, a split utterance ("I was thinking …
 * about dinner") gets one reply to the whole thought instead of a reply
 * talking over the second half.
 */

/** Quiet needed on the local mic before a reply may start (ms). */
export const FLOOR_QUIET_MS = 300;
/** Longest a reply start is held for the floor (ms). */
export const FLOOR_CAP_MS = 2_500;

export class FloorGate {
  private speaking = false;
  /** Time of the last mic sample that read speaking. */
  private lastSpeakingAt = Number.NEGATIVE_INFINITY;
  private readonly quietMs: number;
  private readonly capMs: number;

  constructor(options: { quietMs?: number; capMs?: number } = {}) {
    this.quietMs = options.quietMs ?? FLOOR_QUIET_MS;
    this.capMs = options.capMs ?? FLOOR_CAP_MS;
  }

  /** One mic-meter sample (muted callers should report not speaking). */
  noteMic(speaking: boolean, at: number): void {
    if (speaking) {
      this.lastSpeakingAt = at;
    } else if (this.speaking) {
      // Falling edge: the quiet window starts now.
      this.lastSpeakingAt = at;
    }
    this.speaking = speaking;
  }

  /**
   * How long to wait before starting a reply that became due at `dueAt`;
   * 0 = start now. Re-ask after waiting — the caller may still be talking.
   */
  waitMs(now: number, dueAt: number): number {
    const capLeft = dueAt + this.capMs - now;
    if (capLeft <= 0) return 0;
    if (this.speaking) return Math.min(this.quietMs, capLeft);
    const quietFor = now - this.lastSpeakingAt;
    if (quietFor >= this.quietMs) return 0;
    return Math.min(this.quietMs - quietFor, capLeft);
  }
}

/** Clock the async wait uses (`Date.now` + `setTimeout` in the hook). */
export interface FloorClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

/**
 * Resolve when the reply may start: immediately when the floor is free,
 * otherwise once the caller has been quiet long enough or the cap ran out.
 * Returns how long it waited (for the latency log).
 */
export async function waitForFloor(
  gate: FloorGate,
  clock: FloorClock,
): Promise<number> {
  const dueAt = clock.now();
  for (;;) {
    const ms = gate.waitMs(clock.now(), dueAt);
    if (ms <= 0) return clock.now() - dueAt;
    await clock.sleep(ms);
  }
}
