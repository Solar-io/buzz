/**
 * Per-channel composer drafts, persisted in localStorage. Restoring a draft on
 * channel switch is the desktop Drafts behavior trimmed to what the web shell
 * needs (the composer is the only draft surface here).
 *
 * A draft is not just its text. Uploading a screenshot and then switching
 * channels used to lose the upload silently — the bytes were already on the
 * relay, but the composer's `media` state (and therefore the imeta tags) was
 * gone, so coming back left a bare `![image](…)` line with no attachment
 * metadata behind it. Mention picks had the same failure: the pubkey the
 * author chose from the autocomplete was dropped, so a restored "@Sam" fell
 * back to ambiguous name matching and quietly sent without a p-tag.
 *
 * So the stored shape carries text, uploaded attachments and mention picks
 * together. The legacy shape — a bare string per channel — is still read, so
 * drafts written by an older build survive the upgrade.
 */

import type { BlobDescriptor } from "@/shared/api/blossom";

const DRAFTS_KEY = "buzz.drafts.v1";

/** Everything the composer needs to come back to a channel unchanged. */
export interface DraftState {
  text: string;
  /** Attachments already uploaded and awaiting send. */
  media: BlobDescriptor[];
  /** Original filenames, keyed by blob url — the tray's labels. */
  filenames: { [url: string]: string };
  /** Lowercased inserted name → pubkey, from the mention autocomplete. */
  mentionPicks: { [name: string]: string };
}

/** A stored draft is either the legacy bare string or the full state. */
type StoredDraft = string | Partial<DraftState>;

type DraftMap = { [channelId: string]: StoredDraft };

export const EMPTY_DRAFT: DraftState = {
  text: "",
  media: [],
  filenames: {},
  mentionPicks: {},
};

function loadMap(): DraftMap {
  try {
    const raw = globalThis.localStorage?.getItem(DRAFTS_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as DraftMap;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveMap(map: DraftMap): void {
  try {
    const hasEntries = Object.keys(map).length > 0;
    if (hasEntries) {
      globalThis.localStorage?.setItem(DRAFTS_KEY, JSON.stringify(map));
    } else {
      globalThis.localStorage?.removeItem(DRAFTS_KEY);
    }
  } catch {
    // Storage full or unavailable — drafts are best-effort by design.
  }
}

/** Normalize either stored shape into a complete DraftState. */
function toState(stored: StoredDraft | undefined): DraftState {
  if (typeof stored === "string") {
    return { ...EMPTY_DRAFT, text: stored };
  }
  if (!stored || typeof stored !== "object") {
    return { ...EMPTY_DRAFT };
  }
  return {
    text: typeof stored.text === "string" ? stored.text : "",
    media: Array.isArray(stored.media) ? stored.media : [],
    filenames:
      stored.filenames && typeof stored.filenames === "object"
        ? stored.filenames
        : {},
    mentionPicks:
      stored.mentionPicks && typeof stored.mentionPicks === "object"
        ? stored.mentionPicks
        : {},
  };
}

/** True when nothing is worth persisting — the entry can be dropped. */
function isEmpty(state: DraftState): boolean {
  return (
    state.text === "" &&
    state.media.length === 0 &&
    Object.keys(state.mentionPicks).length === 0
  );
}

export function loadDraft(channelId: string): string {
  return toState(loadMap()[channelId]).text;
}

/** The full draft — text, uploaded attachments and mention picks. */
export function loadDraftState(channelId: string): DraftState {
  return toState(loadMap()[channelId]);
}

/**
 * Saves the draft text; empty text removes the channel's entry entirely.
 *
 * Text-only by name and by history (the typing path calls it on every
 * keystroke), but it MERGES rather than replaces: overwriting the record with
 * a bare string here would discard the attachments and mention picks the
 * composer stored separately. Clearing the text still clears the whole draft,
 * which is what send and cancel want.
 */
export function saveDraft(channelId: string, text: string): void {
  const map = loadMap();
  if (!text) {
    delete map[channelId];
    saveMap(map);
    return;
  }
  const state = toState(map[channelId]);
  map[channelId] = { ...state, text };
  saveMap(map);
}

/** Save the whole draft; an entirely empty draft removes the entry. */
export function saveDraftState(channelId: string, state: DraftState): void {
  const map = loadMap();
  if (isEmpty(state)) {
    delete map[channelId];
  } else {
    map[channelId] = state;
  }
  saveMap(map);
}

export function clearDraft(channelId: string): void {
  const map = loadMap();
  delete map[channelId];
  saveMap(map);
}
