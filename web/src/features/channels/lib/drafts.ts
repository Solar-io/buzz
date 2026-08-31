/**
 * Per-channel composer drafts, persisted in localStorage. Restoring a draft on
 * channel switch is the desktop Drafts behavior trimmed to what the web shell
 * needs (the composer is the only draft surface here).
 */

const DRAFTS_KEY = "buzz.drafts.v1";

type DraftMap = { [channelId: string]: string };

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

export function loadDraft(channelId: string): string {
  return loadMap()[channelId] ?? "";
}

/** Saves the draft; empty text removes the channel's entry entirely. */
export function saveDraft(channelId: string, text: string): void {
  const map = loadMap();
  if (text) {
    map[channelId] = text;
  } else {
    delete map[channelId];
  }
  saveMap(map);
}

export function clearDraft(channelId: string): void {
  saveDraft(channelId, "");
}
