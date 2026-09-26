/**
 * Desktop thinking-pane visibility, remembered per user (plan item 1,
 * Sam 2026-09-26: "starts closed by default and persists open/closed per
 * user"). Every agent DM used to dock the pane open on every load.
 *
 * Keyed by the owner's pubkey, so two identities on one browser keep their
 * own choice. Until the pubkey is known the pane is hidden (the default).
 *
 * Pure and import-free so `node --test` can load it directly.
 */

export const THINKING_PANE_HIDDEN_PREFIX = "buzz:dm-thinking-pane-hidden.v1:";

/** Hidden unless this user last chose to show it. */
export function loadThinkingPaneHidden(
  storage: Pick<Storage, "getItem"> | null | undefined,
  pubkey: string | null,
): boolean {
  if (!pubkey) {
    return true;
  }
  try {
    return storage?.getItem(THINKING_PANE_HIDDEN_PREFIX + pubkey) !== "0";
  } catch {
    return true;
  }
}

export function saveThinkingPaneHidden(
  storage: Pick<Storage, "setItem"> | null | undefined,
  pubkey: string | null,
  hidden: boolean,
): void {
  if (!pubkey) {
    return;
  }
  try {
    storage?.setItem(THINKING_PANE_HIDDEN_PREFIX + pubkey, hidden ? "1" : "0");
  } catch {
    // Storage can throw (private mode, quota); the choice holds this session.
  }
}
