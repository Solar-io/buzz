/**
 * The publish door for `[voice]` finals — the ONE path a final takes from
 * the STT loop into the channel (wired in `ui/HuddleBar.tsx` as
 * `onFinalTranscript`).
 *
 * V4 hardening (2026-09-18 QA defect): a final published while the agent
 * roster has not resolved carries no p tags, and the p tags ARE the wake —
 * the message lands, wakes nobody, draws no reply, and raised no error
 * anywhere. The door closes both silences:
 *
 *  - EMPTY mention set → the send is refused and the refusal is toasted,
 *    naming the unresolved roster and the retry (`gateVoiceMentions`).
 *  - Fresh-add race → a just-added agent may be missing from the polled
 *    member snapshot; the door treats the roster as unresolved until the
 *    snapshot carries it, giving it ONE bounded wait before deciding
 *    (`waitForRosterInclusion`). Publishing against the stale pre-add poll
 *    would wake the wrong set — the false green this kills. The roster hook
 *    merges its own adds optimistically, so the wait resolves within a
 *    render in practice; it is defense, not delay.
 *
 * Plain (typed) chat sends never enter this module — the composer's `send`
 * is untouched and ungated; only the voice-final path is.
 *
 * Every dependency is injected so `node --test` exercises the real door
 * with fakes, mutation-proofs included.
 */

import {
  gateVoiceMentions,
  VOICE_ROSTER_FRESH_POLL_MS,
  VOICE_ROSTER_FRESH_WAIT_MS,
  waitForRosterInclusion,
} from "./voiceTranscript.ts";

/**
 * What the door hands the channel's ordinary send. Shaped exactly like the
 * subset of `MessageSendOptions` voice finals use (mentionPubkeys mutable
 * to match it, so a real `send` slots in without a cast).
 */
export interface VoiceFinalMessage {
  content: string;
  mentionPubkeys: string[];
  threadRef: null;
  mediaTags: string[][];
}

/** The slice of the channel send contract the door relies on. */
export type VoiceFinalSend = (
  message: VoiceFinalMessage,
) => Promise<{ ok: boolean; message?: string | null }>;

/** The surface's toast idiom (`toast.error` from sonner in the bar). */
export type VoiceToastError = (
  message: string,
  options?: { description?: string },
) => void;

export interface VoicePublishDeps {
  /**
   * The huddle's bot roster as the CURRENT polled snapshot sees it — read
   * per call, never captured, so the bounded wait sees the roster as of
   * after the wait.
   */
  currentMentions: () => readonly string[];
  /**
   * Bot pubkeys this session added successfully whose inclusion in the
   * snapshot has not been observed yet (the fresh-add race).
   */
  currentFreshAdds: () => readonly string[];
  /** Called once per fresh add the snapshot has caught up with. */
  onFreshAddIncluded: (pubkey: string) => void;
  /** The channel's ordinary send — the same one the composer uses. */
  send: VoiceFinalSend;
  toastError: VoiceToastError;
  /** Overridable for tests; defaults to the shared bounded wait. */
  waitForRoster?: typeof waitForRosterInclusion;
}

/**
 * Publish one marked `[voice]` final — or refuse loudly. The text arrives
 * already marked (`markVoiceFinal`, applied by the voice hook at its
 * publish sites) and is sent verbatim.
 */
export async function publishVoiceFinal(
  text: string,
  deps: VoicePublishDeps,
): Promise<void> {
  const gate = () =>
    gateVoiceMentions({
      mentionPubkeys: deps.currentMentions(),
      freshAdds: deps.currentFreshAdds(),
    });
  const pruneObserved = () => {
    const mentions = deps.currentMentions();
    for (const pubkey of deps.currentFreshAdds()) {
      if (mentions.includes(pubkey)) {
        deps.onFreshAddIncluded(pubkey);
      }
    }
  };

  pruneObserved();
  const first = gate();
  if (!first.ok && first.reason === "fresh_add_pending") {
    // Bounded await-once: the roster is unresolved only until the snapshot
    // carries the new bot. One wait, then the gate decides on fresh data.
    const included = await (deps.waitForRoster ?? waitForRosterInclusion)({
      isIncluded: () => gate().ok,
      timeoutMs: VOICE_ROSTER_FRESH_WAIT_MS,
      pollMs: VOICE_ROSTER_FRESH_POLL_MS,
    });
    if (included) {
      pruneObserved();
    }
  }
  const settled = gate();
  if (settled.ok) {
    let result: Awaited<ReturnType<typeof deps.send>>;
    try {
      result = await deps.send({
        content: text,
        mentionPubkeys: settled.mentionPubkeys,
        threadRef: null,
        mediaTags: [],
      });
    } catch (error) {
      // session.publish rejects on a closed session; the caller fires this
      // void, so an unhandled rejection would eat the failure silently —
      // the exact class this door exists to close (QA note N1).
      deps.toastError(
        error instanceof Error && error.message
          ? error.message
          : "The transcript could not be sent.",
      );
      return;
    }
    if (!result.ok) {
      // Speech that vanishes with no feedback reads as "it ignored me".
      deps.toastError(result.message || "The transcript could not be sent.");
    }
    return;
  }
  // Blocked: never a silent send, never a silent drop.
  deps.toastError(settled.error);
}
