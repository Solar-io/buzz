/**
 * The device-local Links store — the sidebar section's fallback when the
 * active signer is not the unlocked local key.
 *
 * The relay-backed store (kind-30078 blob, NIP-44-to-self) has no NIP-07
 * path: an extension or web-auth signer can neither decrypt nor publish it,
 * and before this module existed the whole sidebar section vanished for
 * those signers — including the owner on a browser profile without the
 * local key. This store keeps the SAME list shape (`ShortcutDef[]`, same
 * reducers, same caps) in `localStorage`, so the section renders and edits
 * for every signer.
 *
 * The two stores are deliberately separate and never merged or migrated:
 * the local key's blob keeps its cross-device sync, everyone else gets a
 * per-device list, and signing in with the local key on a device that has a
 * local list simply shows the blob instead (the local list stays untouched
 * for the next non-local session). A blob this device cannot decrypt is a
 * blob-store concern only — the blocked-toast refusal for blob writes lives
 * in `hooks.ts` and never blocks this store.
 *
 * Pure node-loadable: no React, and `globalThis.localStorage` is read
 * lazily so `node --test` can supply a fake (the `dockStore.ts` pattern).
 */

import {
  SHORTCUT_SIDEBAR_KEY,
  type ShortcutBarBlob,
  type ShortcutDef,
  emptyShortcutBlob,
  parseShortcutBlob,
  serializeShortcutBlob,
  sidebarShortcuts,
} from "./shortcutBlob.ts";

/** Where the device-local list lives. */
export const LOCAL_LINKS_STORAGE_KEY = "buzz.links.v1";

/** Which store backs the Links section for the current signer. */
export type LinkStorageMode = "blob" | "local";

/**
 * The `canUse` branch, on its own so it can be unit-tested and so the hook's
 * wiring is visibly one function: `"blob"` never touches localStorage, and
 * `"local"` never touches the relay event.
 */
export function linkStorageMode(canUse: boolean): LinkStorageMode {
  return canUse ? "blob" : "local";
}

/** Mirrors `hooks.ts`'s `ShortcutMutation` — same shape, this module stays React-free. */
export interface LocalLinksMutation {
  ok: boolean;
  /** Human-readable reason when `ok` is false; null on success. */
  message: string | null;
}

/** The transform the section already passes to `mutateShortcuts`. */
export type LocalLinksTransform =
  | { ok: true; blob: ShortcutBarBlob }
  | { ok: false; reason: string };

const LOCAL_LINKS_UNAVAILABLE_MESSAGE =
  "Links could not be saved on this device — storage is unavailable.";

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Wrap a flat list as the blob shape the sidebar reducers already take and
 * give back. The stored file is therefore the same hardened format the relay
 * blob uses — one reserved `__sidebar__` key — which buys the URL
 * re-validation, the per-list cap and the byte budget from
 * `shortcutBlob.ts` for free instead of re-declaring them for localStorage.
 */
function wrapAsBlob(list: ShortcutDef[]): ShortcutBarBlob {
  return list.length === 0
    ? emptyShortcutBlob()
    : { v: 1, shortcuts: { [SHORTCUT_SIDEBAR_KEY]: list } };
}

/**
 * The stored local links, validated on read exactly like the decrypted blob.
 * Missing, malformed or future-version storage reads as an EMPTY list, never
 * an error: the section always renders, and an unreadable file must not take
 * the + button down with it.
 */
export function readLocalLinks(): ShortcutDef[] {
  const store = storage();
  if (!store) {
    return [];
  }
  let raw: unknown;
  try {
    raw = JSON.parse(store.getItem(LOCAL_LINKS_STORAGE_KEY) ?? "");
  } catch {
    return [];
  }
  const parsed = parseShortcutBlob(raw);
  return parsed.ok ? sidebarShortcuts(parsed.blob) : [];
}

/**
 * Apply a sidebar-blob transform to the local list and persist the result.
 *
 * Async to match `mutateShortcuts`' `Promise` signature, so the section and
 * dialog can call either store through the same await/then shape. The read
 * happens inside the call, not from React state, so two mutations in one
 * render cannot drop each other's writes.
 */
export async function mutateLocalLinks(
  fn: (blob: ShortcutBarBlob) => LocalLinksTransform,
): Promise<LocalLinksMutation> {
  const store = storage();
  if (!store) {
    return { ok: false, message: LOCAL_LINKS_UNAVAILABLE_MESSAGE };
  }
  const result = fn(wrapAsBlob(readLocalLinks()));
  if (!result.ok) {
    return { ok: false, message: result.reason };
  }
  const list = sidebarShortcuts(result.blob);
  try {
    store.setItem(
      LOCAL_LINKS_STORAGE_KEY,
      serializeShortcutBlob(wrapAsBlob(list)),
    );
  } catch {
    // Quota or disabled storage — refuse with a reason rather than throw.
    return { ok: false, message: LOCAL_LINKS_UNAVAILABLE_MESSAGE };
  }
  return { ok: true, message: null };
}
