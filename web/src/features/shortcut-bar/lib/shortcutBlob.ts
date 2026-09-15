/**
 * The plaintext shortcut-bar blob — the wire format, parsed and mutated as
 * pure reducers.
 *
 * One event per user (kind 30078, `d="shortcut-bar"`), whose decrypted
 * content is `{v: 1, shortcuts: {<channelId>: ShortcutDef[]}}`. The key is
 * the channel UUID, the same `channel.id` for channels AND DMs — DMs are
 * channels with a server-minted UUID, and group DMs have no single pubkey to
 * key by, so anything else would be wrong for exactly the case that matters.
 *
 * Every mutation re-serializes the WHOLE blob and checks it against the byte
 * budget before the caller encrypts, so an over-budget edit is refused at the
 * UI with a reason instead of published and dropped by the relay (whose
 * content cap is 256 KiB — measured at `ingest.rs:2239` — but a client
 * budget an order of magnitude under it keeps the blob cheap to fetch on
 * every channel open).
 *
 * The one import is `panelRegistry` for `normalizePanelUrl`, the same URL
 * guard the Files dock uses: `javascript:`/`data:`/`blob:` execute in this
 * origin, and this origin holds the user's key. Pure otherwise, so
 * `node --test` can load it directly.
 */

import {
  defaultPanelLabel,
  normalizePanelUrl,
} from "../../webPanels/lib/panelRegistry.ts";

/** How a shortcut opens: a real browser tab, or the in-app dock overlay. */
export type ShortcutMode = "window" | "overlay";

export interface ShortcutDef {
  /** Stable id — `sc:<n>`, allocated across the whole blob. */
  id: string;
  label: string;
  url: string;
  mode: ShortcutMode;
}

export interface ShortcutBarBlob {
  v: 1;
  shortcuts: Record<string, ShortcutDef[]>;
}

/** Live shortcuts allowed per channel — each pill is chrome on every header. */
export const MAX_SHORTCUTS_PER_CHANNEL = 12;
/** A pill truncates visually anyway; 32 is the difference between "kept" and a sentence. */
export const MAX_SHORTCUT_LABEL_CHARS = 32;
/** Tracking URLs, not blog posts. */
export const MAX_SHORTCUT_URL_CHARS = 512;
/**
 * Client-side budget for the SERIALIZED plaintext. NIP-44 v2 ciphertext
 * expands ~1.5x, so this lands near 25 KB on the wire — a tenth of the
 * relay's 262,144-byte event content cap, with headroom to spare.
 */
export const SHORTCUT_BLOB_BUDGET_BYTES = 16_384;

/** Shown verbatim when a mutation would push the blob over budget. */
export const SHORTCUT_BUDGET_MESSAGE = `Shortcut storage is full — the encrypted sync budget is ${SHORTCUT_BLOB_BUDGET_BYTES.toLocaleString("en-US")} bytes. Remove some shortcuts first.`;

export type ShortcutMutationResult =
  | { ok: true; blob: ShortcutBarBlob }
  | { ok: false; reason: string };

export function emptyShortcutBlob(): ShortcutBarBlob {
  return { v: 1, shortcuts: {} };
}

export function serializeShortcutBlob(blob: ShortcutBarBlob): string {
  return JSON.stringify(blob);
}

/** UTF-8 length — the budget is bytes, not characters. */
export function blobByteLength(plaintext: string): number {
  return new TextEncoder().encode(plaintext).length;
}

export type ParsedShortcutBlob =
  | { ok: true; blob: ShortcutBarBlob }
  | { ok: false; reason: "future-version" | "malformed" };

function parseShortcutEntry(raw: unknown): ShortcutDef | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const entry = raw as Record<string, unknown>;
  if (typeof entry.id !== "string" || entry.id.length === 0) {
    return null;
  }
  if (typeof entry.url !== "string") {
    return null;
  }
  // Re-validate on read, exactly like the Files dock's sanitizeCustom: a URL
  // stored by an older build or hand-edited in devtools is not trusted just
  // because it is in the blob.
  const url = normalizePanelUrl(entry.url);
  if (url === null) {
    return null;
  }
  const mode: ShortcutMode = entry.mode === "overlay" ? "overlay" : "window";
  const label =
    typeof entry.label === "string" && entry.label.trim().length > 0
      ? entry.label.trim()
      : defaultPanelLabel(url);
  return { id: entry.id, label, url, mode };
}

/**
 * Parse decrypted blob content, dropping anything unusable.
 *
 * A blob whose `v` is a HIGHER major version is reported as
 * `future-version` rather than parsed best-effort: it was written by a newer
 * client with fields this build does not know, and publishing a v1
 * interpretation over it would destroy them. The caller turns that into a
 * read-only, write-blocked bar.
 */
export function parseShortcutBlob(raw: unknown): ParsedShortcutBlob {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "malformed" };
  }
  const candidate = raw as Record<string, unknown>;
  if (candidate.v !== 1) {
    const future =
      typeof candidate.v === "number" && Number.isFinite(candidate.v)
        ? candidate.v > 1
        : false;
    return { ok: false, reason: future ? "future-version" : "malformed" };
  }
  if (typeof candidate.shortcuts !== "object" || candidate.shortcuts === null) {
    return { ok: false, reason: "malformed" };
  }
  const blob = emptyShortcutBlob();
  for (const [channelId, list] of Object.entries(candidate.shortcuts)) {
    if (!Array.isArray(list)) {
      continue;
    }
    const seen = new Set<string>();
    const shortcuts: ShortcutDef[] = [];
    for (const entry of list) {
      const shortcut = parseShortcutEntry(entry);
      if (!shortcut || seen.has(shortcut.id)) {
        continue;
      }
      seen.add(shortcut.id);
      shortcuts.push(shortcut);
      if (shortcuts.length === MAX_SHORTCUTS_PER_CHANNEL) {
        break;
      }
    }
    if (shortcuts.length > 0) {
      blob.shortcuts[channelId] = shortcuts;
    }
  }
  return { ok: true, blob };
}

/** The shortcuts pinned to one channel, in blob order. */
export function shortcutListFor(
  blob: ShortcutBarBlob,
  channelId: string,
): ShortcutDef[] {
  return blob.shortcuts[channelId] ?? [];
}

/**
 * Allocate `sc:<n>` from the highest n anywhere in the blob, never reusing a
 * removed id — the same rule as `nextCustomPanelId`.
 */
export function nextShortcutId(blob: ShortcutBarBlob): string {
  let highest = 0;
  for (const list of Object.values(blob.shortcuts)) {
    for (const shortcut of list) {
      const match = /^sc:(\d+)$/.exec(shortcut.id);
      if (match) {
        highest = Math.max(highest, Number(match[1]));
      }
    }
  }
  return `sc:${highest + 1}`;
}

function validateInput(input: {
  url: string;
  label?: string;
  mode?: ShortcutMode;
}): { url: string; label: string } | { ok: false; reason: string } {
  const url = normalizePanelUrl(input.url);
  if (url === null) {
    return {
      ok: false,
      reason: "That is not an http:// or https:// address.",
    };
  }
  if (url.length > MAX_SHORTCUT_URL_CHARS) {
    return {
      ok: false,
      reason: `That URL is too long — the limit is ${MAX_SHORTCUT_URL_CHARS} characters.`,
    };
  }
  const label = input.label?.trim() ?? "";
  if (label.length > MAX_SHORTCUT_LABEL_CHARS) {
    return {
      ok: false,
      reason: `Keep the label to ${MAX_SHORTCUT_LABEL_CHARS} characters or fewer.`,
    };
  }
  return { url, label: label || defaultPanelLabel(url) };
}

function assemble(
  blob: ShortcutBarBlob,
  channelId: string,
  shortcuts: ShortcutDef[],
): ShortcutMutationResult {
  const nextList = shortcuts.slice(0, MAX_SHORTCUTS_PER_CHANNEL);
  const shortcuts1 = { ...blob.shortcuts };
  if (nextList.length === 0) {
    // Prune-on-write: a channel with no shortcuts releases its key entirely,
    // so dead channels stop leaking through the blob and the payload stays
    // small.
    delete shortcuts1[channelId];
  } else {
    shortcuts1[channelId] = nextList;
  }
  const next: ShortcutBarBlob = { v: 1, shortcuts: shortcuts1 };
  const plaintext = serializeShortcutBlob(next);
  if (blobByteLength(plaintext) > SHORTCUT_BLOB_BUDGET_BYTES) {
    // Never publish an over-budget blob: the relay would take this one and
    // the user's older (smaller, working) blob is replaced by it.
    return { ok: false, reason: SHORTCUT_BUDGET_MESSAGE };
  }
  return { ok: true, blob: next };
}

/**
 * Append a shortcut to a channel's list, or explain why not.
 *
 * Duplicates are allowed deliberately: the same URL in both modes (a tab
 * beside the conversation AND a dock overlay) is a real arrangement, and the
 * mode is part of the entry.
 */
export function addShortcut(
  blob: ShortcutBarBlob,
  channelId: string,
  input: { url: string; label?: string; mode?: ShortcutMode },
): ShortcutMutationResult {
  const existing = shortcutListFor(blob, channelId);
  if (existing.length >= MAX_SHORTCUTS_PER_CHANNEL) {
    return {
      ok: false,
      reason: `A channel holds at most ${MAX_SHORTCUTS_PER_CHANNEL} shortcuts.`,
    };
  }
  const valid = validateInput(input);
  if (!("url" in valid)) {
    return valid;
  }
  const added: ShortcutDef = {
    id: nextShortcutId(blob),
    label: valid.label,
    url: valid.url,
    mode: input.mode === "overlay" ? "overlay" : "window",
  };
  return assemble(blob, channelId, [...existing, added]);
}

/** Rewrite one shortcut in place, keeping its id and position. */
export function updateShortcut(
  blob: ShortcutBarBlob,
  channelId: string,
  id: string,
  input: { url: string; label?: string; mode?: ShortcutMode },
): ShortcutMutationResult {
  const existing = shortcutListFor(blob, channelId);
  const index = existing.findIndex((shortcut) => shortcut.id === id);
  if (index === -1) {
    return { ok: false, reason: "That shortcut no longer exists." };
  }
  const valid = validateInput(input);
  if (!("url" in valid)) {
    return valid;
  }
  const next = [...existing];
  next[index] = {
    ...existing[index],
    label: valid.label,
    url: valid.url,
    mode: input.mode === "overlay" ? "overlay" : "window",
  };
  return assemble(blob, channelId, next);
}

/**
 * Remove one shortcut. An unknown id is a no-op success, so a stale context
 * menu (the channel edited on another device mid-flight) cannot error the
 * user about something they asked to delete anyway.
 */
export function removeShortcut(
  blob: ShortcutBarBlob,
  channelId: string,
  id: string,
): ShortcutMutationResult {
  const existing = shortcutListFor(blob, channelId);
  return assemble(
    blob,
    channelId,
    existing.filter((shortcut) => shortcut.id !== id),
  );
}
