/**
 * Pulse is the workspace-wide activity feed: NIP-01 `kind:1` text notes,
 * reacted to with `kind:7`, from everyone / your contacts (`kind:3`) / your
 * registered agents (`kind:30177`) / yourself.
 *
 * The desktop client reaches these through Tauri commands
 * (`get_global_notes`, `get_notes_timeline`, `get_liked_notes`,
 * `get_user_notes`, `get_note_reactions` in
 * `desktop/src-tauri/src/commands/social.rs`), each of which is a thin wrapper
 * around a plain relay REQ. The web has no Rust side, so it issues the same
 * filters straight down the shared `RelaySession`. The shapes below are the
 * web's own — deliberately decoupled from the desktop's `socialTypes.ts`.
 */

/** One `kind:1` note, normalised off the wire. */
export interface PulseNote {
  id: string;
  pubkey: string;
  /** Event `created_at`, Unix seconds. */
  createdAt: number;
  content: string;
  tags: string[][];
}

/** Folded `kind:7` reaction state for one note. */
export interface PulseReactionState {
  /** Number of distinct `+` reactions the relay returned. */
  count: number;
  /** The viewer is one of them. */
  reactedByCurrentUser: boolean;
}

/** Which feed the Pulse view is showing. */
export type PulseTab =
  | "search"
  | "everyone"
  | "people"
  | "liked"
  | "agents"
  | "mine";

/** Every tab, in the order the tab bar renders them. */
export const PULSE_TABS: readonly PulseTab[] = [
  "search",
  "everyone",
  "people",
  "liked",
  "agents",
  "mine",
] as const;

/** NIP-01 short text note — the Pulse feed's payload. */
export const KIND_TEXT_NOTE = 1;
/** NIP-02 contact list — the "Following" tab's author set. */
export const KIND_CONTACT_LIST = 3;
/** NIP-09 deletion request — retracts a reaction on the "Liked" tab. */
export const KIND_DELETION = 5;
/** NIP-25 reaction — the upvote/like on a note. */
export const KIND_REACTION = 7;
/** NIP-34 repository announcement; its `a` address marks project comments. */
export const KIND_REPO_ANNOUNCEMENT = 30617;
