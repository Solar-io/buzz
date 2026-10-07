/**
 * Push-to-talk commit (voice fast path plan §4.3). Pure and import-free.
 *
 * The STT bridge's VAD counts silence only from audio frames it is fed, and
 * the client stops sending frames when push-to-talk is released — so a PTT
 * utterance never ends until frames resume. On the PTT falling edge the
 * client flushes the batcher tail and sends `{"type":"commit"}`: close the
 * utterance now, transcribe it, keep the session open. A bridge that does
 * not know `commit` ignores it (unknown controls are dropped), so this is
 * safe to ship before the bridge supports it.
 *
 * The final that answers a commit publishes with NO merge wait — the caller
 * already said "I'm done" by letting go of the key.
 */

/** The control frame sent on release. */
export const COMMIT_CONTROL = '{"type":"commit"}';

/**
 * How long after a commit the next final still counts as its answer (and
 * skips the merge window). Generous: transcription is ~100 ms, but a bridge
 * that ignores `commit` answers on the next VAD close instead, and that
 * final must not jump the merge window long after the release.
 */
export const PTT_COMMIT_WINDOW_MS = 2_500;

/** Push-to-talk released: the mic was live and now is not, in PTT mode. */
export function isPttRelease(
  wasLive: boolean,
  live: boolean,
  pushToTalk: boolean,
): boolean {
  return pushToTalk && wasLive && !live;
}

/** Tracks the one final a commit is waiting for. */
export class CommitWindow {
  private until: number | null = null;

  /** A commit was sent at `now`. */
  open(now: number): void {
    this.until = now + PTT_COMMIT_WINDOW_MS;
  }

  /**
   * A final arrived at `now`: should it publish immediately? True once per
   * commit, and only inside the window.
   */
  takeImmediate(now: number): boolean {
    const until = this.until;
    this.until = null;
    return until !== null && now <= until;
  }
}
