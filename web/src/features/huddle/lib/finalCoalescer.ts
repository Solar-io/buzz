/**
 * Final-transcript coalescing for huddle voice mode. Pure, import-free, and
 * clock-injected: the hook owns the timer, this owns the decisions.
 *
 * Why: the STT bridge ends an utterance on a short pause, and every final
 * used to publish as its own `[voice]` message. One spoken thought with a
 * breath in the middle went out as two messages 1-3 s apart — and each one
 * starts an agent turn (and, half-duplex, holds the mic). So a gated final is
 * BUFFERED; the joined text publishes once there has been MERGE_MS with no
 * new speech activity (a partial or another final). A buffered run older
 * than MAX_RUN_MS flushes anyway, so a monologue still reaches the channel.
 */

/** Quiet after the last speech activity before the buffer publishes (ms). */
export const MERGE_MS = 300;
/** Oldest a buffered run may get before it flushes regardless (ms). */
export const MAX_RUN_MS = 30_000;

export class FinalCoalescer {
  private parts: string[] = [];
  private firstAt = 0;

  /** True while at least one final is buffered. */
  get pending(): boolean {
    return this.parts.length > 0;
  }

  /**
   * Buffer one gated final. Returns the joined text when this final pushed
   * the run past MAX_RUN_MS (the caller publishes it now), otherwise null
   * (the caller (re)arms its MERGE_MS timer). Empty text is ignored.
   */
  push(text: string, now: number): string | null {
    const clean = text.trim();
    if (clean.length === 0) {
      return null;
    }
    if (this.parts.length === 0) {
      this.firstAt = now;
    }
    this.parts.push(clean);
    return this.overCap(now) ? this.flush() : null;
  }

  /**
   * Speech activity without a final (a partial). Keeps the run open; returns
   * the joined text only if the run is already past MAX_RUN_MS.
   */
  activity(now: number): string | null {
    return this.overCap(now) ? this.flush() : null;
  }

  /** Take the buffered run as one space-joined string, or null if empty. */
  flush(): string | null {
    if (this.parts.length === 0) {
      return null;
    }
    const text = this.parts.join(" ");
    this.parts = [];
    return text;
  }

  private overCap(now: number): boolean {
    return this.parts.length > 0 && now - this.firstAt >= MAX_RUN_MS;
  }
}

/** Timer + clock the merger schedules with (window.setTimeout in the hook). */
export interface MergerClock {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (id: number) => void;
}

/**
 * The coalescer plus its MERGE_MS timer — the exact object the hook drives,
 * so the tests exercise the shipped wiring rather than a copy of it.
 * `emit` receives each merged run exactly once.
 */
export class FinalMerger {
  private readonly buffer = new FinalCoalescer();
  private timer: number | null = null;
  private readonly emit: (text: string) => void;
  private readonly clock: MergerClock;

  constructor(emit: (text: string) => void, clock: MergerClock) {
    this.emit = emit;
    this.clock = clock;
  }

  /** A gated final arrived: buffer it and restart the quiet window. */
  final(text: string): void {
    this.settle(this.buffer.push(text, this.clock.now()));
  }

  /** A partial arrived: he is still talking, so restart the quiet window. */
  partial(): void {
    this.settle(this.buffer.activity(this.clock.now()));
  }

  /** Publish whatever is buffered right now (stop, teardown, socket close). */
  flush(): void {
    this.cancel();
    const text = this.buffer.flush();
    if (text !== null) {
      this.emit(text);
    }
  }

  private settle(capped: string | null): void {
    this.cancel();
    if (capped !== null) {
      this.emit(capped);
      return;
    }
    if (this.buffer.pending) {
      this.timer = this.clock.setTimer(() => {
        this.timer = null;
        this.flush();
      }, MERGE_MS);
    }
  }

  private cancel(): void {
    if (this.timer !== null) {
      this.clock.clearTimer(this.timer);
      this.timer = null;
    }
  }
}
