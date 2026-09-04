/**
 * Huddle naming and error phrasing — the desktop's
 * `lib/huddleChannelName.ts` and `lib/huddleError.ts`, ported.
 *
 * Both are pure string work, and both matter more than they look: the name
 * is what the sidebar shows for a live call, and the error is the only thing
 * a user sees when a relay is built without audio support.
 *
 * IMPORT-FREE ON PURPOSE. The label resolver is injected rather than reached
 * for, so this module has no runtime dependencies and `node --test` can load
 * it directly (a static extensionless import of a sibling `.ts` makes a
 * module untestable under the repo's runner). It also keeps the pubkey
 * fallback in one place: callers pass the shared `truncatePubkey`, which is
 * what `pnpm check:pubkey-truncation` requires anyway.
 */

/** First word of a display name — "Sam Gallant" → "Sam". */
function firstName(label: string): string {
  return label.trim().split(/\s+/)[0] ?? "";
}

export interface HuddleNameInput {
  /** "stream" | "forum" | "dm". */
  channelType: string;
  /** Channel name, for non-DM channels. */
  channelName: string;
  /** DM participants, in the channel's own order. */
  participantPubkeys?: readonly string[];
  /** The viewer, who is listed FIRST when they are a participant. */
  currentPubkey?: string | null;
  /**
   * pubkey → the best label available, already falling back to the shared
   * `truncatePubkey`. Injected; see the module note.
   */
  labelOf: (pubkey: string) => string;
}

/**
 * "#design huddle" for a channel, "Sam <> Ada huddle" for a DM.
 *
 * The viewer leads the DM name when they are in it, which is the desktop's
 * ordering — the name reads from the reader outwards, so the same
 * conversation is not called two different things by its two participants
 * in any list they both look at.
 */
export function buildHuddleChannelName(input: HuddleNameInput): string {
  if (input.channelType !== "dm") {
    const name = input.channelName.trim();
    return name ? `${name} huddle` : "huddle";
  }
  const participants = input.participantPubkeys ?? [];
  const self = input.currentPubkey?.toLowerCase() ?? null;
  const ordered =
    self && participants.some((pubkey) => pubkey.toLowerCase() === self)
      ? [
          input.currentPubkey as string,
          ...participants.filter((pubkey) => pubkey.toLowerCase() !== self),
        ]
      : [...participants];
  const names = ordered
    .map((pubkey) => firstName(input.labelOf(pubkey)))
    .filter(Boolean);
  return names.length === 0 ? "huddle" : `${names.join(" <> ")} huddle`;
}

export type HuddleAction = "join" | "start";

const HUDDLE_AUDIO_UNAVAILABLE_MESSAGE =
  "Huddle audio isn't available on this server. Ask an administrator to turn it on.";

/**
 * A message a person can act on.
 *
 * The one substitution that earns its place is `huddle_audio_unavailable`:
 * the relay can be deployed without the audio service, and the raw code says
 * nothing about whose problem that is or what to do next.
 */
export function formatHuddleActionError(
  error: unknown,
  action: HuddleAction,
): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : null;
  const message = raw?.trim();
  const normalized = message?.toLowerCase();
  if (
    normalized?.includes("huddle_audio_unavailable") ||
    normalized?.includes("huddle audio unavailable in this deployment")
  ) {
    return HUDDLE_AUDIO_UNAVAILABLE_MESSAGE;
  }
  if (message) {
    return message;
  }
  return action === "join"
    ? "Couldn't join the huddle."
    : "Couldn't start the huddle.";
}
