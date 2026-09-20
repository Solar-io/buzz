/**
 * The web's NIP-RS wire format — read state as ONE encrypted kind:30078
 * event per browser install (docs/nips/NIP-RS.md), so a new browser starts
 * from Sam's identity rather than an empty localStorage.
 *
 * Why kind:30078 again (the shortcut bar already uses it): the relay accepts
 * it with only `Scope::UsersWrite`, stores it globally-only, and it is
 * parameterized-replaceable per `(pubkey, kind, d)` — the relay keeps the
 * newest event per coordinate and there is nothing to delete. An `h` tag
 * would get the event REJECTED (global-only kind), so none is added.
 *
 * Why a RANDOM slot id rather than one fixed `d` value: each browser install
 * writes its own coordinate (`read-state:<32hex>`), so two browsers never
 * overwrite each other's blob — boot fetch max-MERGES every slot. The
 * `contexts` map is bare channelId → marker, which is exactly the desktop's
 * context shape (`desktop readStateFormat.isValidBlob`), so the two clients
 * interoperate in both directions. `inbox_read`/`inbox_unread` are web-only
 * extensions; the desktop's validator ignores unknown fields, so carrying
 * them costs nothing there.
 *
 * Pure and import-free so `node --test` can load it directly (same rule as
 * shortcutEvent.ts); the subscription/publish lifecycle lives in
 * readStateSync.ts.
 */

/** NIP-78 app data — the kind the relay already stores globally-only. */
export const KIND_READ_STATE = 30078;

/** `d` coordinate prefix fixed by NIP-RS so a relay can recognize the shape. */
export const READ_STATE_D_TAG_PREFIX = "read-state:";

/** NIP-RS rejects blobs with more than 10,000 context entries outright. */
export const MAX_CONTEXTS = 10_000;

/**
 * Publish cap per inbox overlay direction. Mirrors INBOX_READ_MAX_ENTRIES
 * (the local store's cap) rather than importing it — this module is
 * deliberately import-free, and the two caps WANT to move together only by
 * decision, not by accident.
 */
export const MAX_INBOX_MARKERS_PER_DIRECTION = 500;

/**
 * Hard plaintext ceiling for the published blob. NIP-44 v2 caps plaintext at
 * 65,535 bytes and expands it ~1.4x in ciphertext; 32 KiB keeps the event
 * well inside both while holding thousands of markers. Over budget after
 * pruning is a REFUSAL, not a trim-again — silent further trimming would
 * drop exactly the oldest markers a merge just fought to keep.
 */
export const READ_STATE_MAX_PLAINTEXT_BYTES = 32_768;

/** The decrypted blob. `contexts` keys are bare channelIds (desktop-shaped). */
export interface WebReadStateBlob {
  v: 1;
  client_id: string;
  /** channelId → newest SEEN message createdAt (unix seconds). */
  contexts: Record<string, number>;
  /** Explicitly-read inbox overlay (msgId → createdAt), web extension. */
  inbox_read?: Record<string, number>;
  /** Explicitly-unread overlay — the "come back to this" flag, web extension. */
  inbox_unread?: Record<string, number>;
}

/** Both inbox overlay directions, structurally identical to InboxReadState. */
export interface InboxOverlayPair {
  read: Record<string, number>;
  unread: Record<string, number>;
}

/**
 * Tags for a read-state publish. Exactly one `d` and one `t=read-state` tag
 * (NIP-RS requires exactly one of each; more or fewer must be ignored by
 * receivers). No `h` tag — see the header.
 */
export function buildReadStateEventTags(slotId: string): string[][] {
  return [
    ["d", `${READ_STATE_D_TAG_PREFIX}${slotId}`],
    ["t", "read-state"],
  ];
}

const SLOT_ID_PATTERN = /^[0-9a-f]{32}$/;

/**
 * NIP-RS fixes the slot shape at exactly 32 LOWERCASE hex characters so a
 * relay can recognize read-state coordinates structurally. Desktop slot ids
 * (16 random bytes, hex) already match; uppercase or wrong-length ids are
 * foreign coordinates and must be ignored, not merged.
 */
export function isValidReadStateDTag(value: string | undefined): boolean {
  if (!value?.startsWith(READ_STATE_D_TAG_PREFIX)) return false;
  return SLOT_ID_PATTERN.test(value.slice(READ_STATE_D_TAG_PREFIX.length));
}

/**
 * Grow-only max-merge of channel markers (NIP-RS merge rule): remote can only
 * ADVANCE a marker, never lower one. Returns the same `local` reference when
 * remote adds nothing, so a React state update fed the result is a no-op.
 * Non-integer remote values are dropped entry-wise — one bad entry must not
 * discard the rest of a decrypted blob.
 */
export function mergeChannelMarkers(
  local: Record<string, number>,
  remote: Record<string, number>,
): Record<string, number> {
  let merged: Record<string, number> | null = null;
  for (const [channelId, marker] of Object.entries(remote)) {
    if (!isIntegerTimestamp(marker)) {
      continue;
    }
    if (marker <= (local[channelId] ?? 0)) {
      continue;
    }
    if (merged === null) {
      merged = { ...local };
    }
    merged[channelId] = marker;
  }
  return merged ?? local;
}

/**
 * Union-max of both inbox overlay directions, then conflict resolution:
 * a msgId landing in BOTH directions resolves UNREAD-WINS. A lost
 * "come back to this" flag is the one error this merge must never commit —
 * it is the only state a user sets by hand and expects to survive; a wrongly
 * kept unread is one click to clear. Same-reference no-op as the channel
 * merge.
 */
export function mergeInboxOverlay(
  local: InboxOverlayPair,
  remote: InboxOverlayPair,
): InboxOverlayPair {
  const read = maxUnionMarkers(local.read, remote.read) ?? local.read;
  const unread = maxUnionMarkers(local.unread, remote.unread) ?? local.unread;
  let resolvedRead: Record<string, number> | null = null;
  for (const messageId of Object.keys(unread)) {
    if (!(messageId in read)) {
      continue;
    }
    // Copy before the first delete — `read` may still be the caller's object.
    if (resolvedRead === null) {
      resolvedRead = { ...read };
    }
    delete resolvedRead[messageId];
  }
  const finalRead = resolvedRead ?? read;
  if (finalRead === local.read && unread === local.unread) {
    return local;
  }
  return { read: finalRead, unread };
}

/** Keep the newest `max` markers in one map — pruneInboxMarkers's shape. */
export function keepNewestMarkers(
  markers: Record<string, number>,
  max: number,
): Record<string, number> {
  const entries = Object.entries(markers);
  if (entries.length <= max) {
    return markers;
  }
  entries.sort(([, left], [, right]) => right - left);
  return Object.fromEntries(entries.slice(0, max));
}

export interface ReadStatePublishPayload {
  blob: WebReadStateBlob;
  plaintext: string;
}

/**
 * Build the publish blob from the two localStorage stores: prune to the caps
 * (10k contexts, 500 per overlay direction, newest kept), then serialize.
 * Over the 32 KiB plaintext ceiling AFTER pruning is a hard refusal — the
 * caller must not publish, because a publish that silently dropped content
 * would be a merge the merge rule cannot express (max-merge can only grow,
 * so the dropped entries would look deleted).
 */
export function buildPublishPayload(args: {
  clientId: string;
  contexts: Record<string, number>;
  inboxRead?: Record<string, number>;
  inboxUnread?: Record<string, number>;
}):
  | { ok: true; payload: ReadStatePublishPayload }
  | { ok: false; reason: string } {
  const contexts = keepNewestMarkers(args.contexts, MAX_CONTEXTS);
  const inboxRead = keepNewestMarkers(
    args.inboxRead ?? {},
    MAX_INBOX_MARKERS_PER_DIRECTION,
  );
  const inboxUnread = keepNewestMarkers(
    args.inboxUnread ?? {},
    MAX_INBOX_MARKERS_PER_DIRECTION,
  );
  // Empty overlay directions are omitted entirely — the blob stays
  // desktop-shaped (v/client_id/contexts only) for anyone who never touches
  // the inbox overlay.
  const blob: WebReadStateBlob = {
    v: 1,
    client_id: args.clientId,
    contexts,
  };
  if (Object.keys(inboxRead).length > 0) {
    blob.inbox_read = inboxRead;
  }
  if (Object.keys(inboxUnread).length > 0) {
    blob.inbox_unread = inboxUnread;
  }
  const plaintext = JSON.stringify(blob);
  if (plaintextByteLength(plaintext) > READ_STATE_MAX_PLAINTEXT_BYTES) {
    return {
      ok: false,
      reason: `read-state blob is ${plaintextByteLength(plaintext)} bytes after pruning (cap ${READ_STATE_MAX_PLAINTEXT_BYTES})`,
    };
  }
  return { ok: true, payload: { blob, plaintext } };
}

/**
 * `created_at` for the next publish: never older than anything already seen,
 * so a clock running behind another device cannot publish a blob that loses
 * to that device's older write (NIP-RS clock-skew rule; the shortcut bar's
 * nextShortcutCreatedAt is the same pin).
 */
export function nextPublishCreatedAt(
  nowSeconds: number,
  highestSeenCreatedAt: number,
): number {
  return Math.max(Math.floor(nowSeconds), highestSeenCreatedAt + 1);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIntegerTimestamp(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 4_294_967_295
  );
}

/**
 * Field-tolerant blob validation, deliberately shaped like the desktop's
 * `isValidBlob`: checks v / client_id / contexts and IGNORES unknown fields,
 * so a blob with extra top-level keys (ours or a future client's) stays
 * readable everywhere. Unknown `v` values are rejected — a newer schema's
 * markers are not ours to interpret.
 */
export function isValidWebReadStateBlob(obj: unknown): obj is WebReadStateBlob {
  if (!isPlainRecord(obj)) {
    return false;
  }
  if (obj.v !== 1) {
    return false;
  }
  if (
    typeof obj.client_id !== "string" ||
    obj.client_id.length === 0 ||
    obj.client_id.length > 64
  ) {
    return false;
  }
  if (!isPlainRecord(obj.contexts)) {
    return false;
  }
  if (Object.keys(obj.contexts).length > MAX_CONTEXTS) {
    return false;
  }
  return true;
}

/** Drop invalid entries (non-uint32 value, >256-byte key), keep the rest. */
function sanitizeMarkerRecord(
  record: Record<string, unknown>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(record)) {
    if (plaintextByteLength(key) > 256) {
      continue;
    }
    if (!isIntegerTimestamp(value)) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * Parse one decrypted plaintext into a sanitized blob, or null when it is not
 * valid JSON or not a valid blob. Null is the caller's "skip this event"
 * signal — one bad payload must never take the batch down with it.
 */
export function parseWebReadStateBlob(
  plaintext: string,
): WebReadStateBlob | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return null;
  }
  if (!isValidWebReadStateBlob(parsed)) {
    return null;
  }
  const blob: WebReadStateBlob = {
    v: 1,
    client_id: parsed.client_id,
    contexts: sanitizeMarkerRecord(parsed.contexts),
  };
  if (isPlainRecord(parsed.inbox_read)) {
    blob.inbox_read = sanitizeMarkerRecord(parsed.inbox_read);
  }
  if (isPlainRecord(parsed.inbox_unread)) {
    blob.inbox_unread = sanitizeMarkerRecord(parsed.inbox_unread);
  }
  return blob;
}

/** The folded result of a boot-fetch batch, in localStorage-store shapes. */
export interface MergedRemoteReadState {
  contexts: Record<string, number>;
  inboxRead: Record<string, number>;
  inboxUnread: Record<string, number>;
}

/**
 * Fold a boot-fetch batch: each entry is a decrypted plaintext or null
 * (decrypt failed / unparseable). Nulls are skipped silently — NIP-RS
 * validation discards the EVENT, never the fetch — and the survivors are
 * max-merged per map. Direction conflicts inside the folded result are NOT
 * resolved here; feeding this into mergeInboxOverlay applies unread-wins.
 */
export function mergePayloadBatch(
  payloads: readonly (string | null)[],
): MergedRemoteReadState {
  const contexts: Record<string, number> = {};
  const inboxRead: Record<string, number> = {};
  const inboxUnread: Record<string, number> = {};
  for (const payload of payloads) {
    if (payload === null) {
      continue;
    }
    const blob = parseWebReadStateBlob(payload);
    if (blob === null) {
      continue;
    }
    accumulateMax(contexts, blob.contexts);
    if (blob.inbox_read !== undefined) {
      accumulateMax(inboxRead, blob.inbox_read);
    }
    if (blob.inbox_unread !== undefined) {
      accumulateMax(inboxUnread, blob.inbox_unread);
    }
  }
  return { contexts, inboxRead, inboxUnread };
}

/** Union-max `source` into `target` (mutates target, the accumulator). */
function accumulateMax(
  target: Record<string, number>,
  source: Record<string, number>,
): void {
  for (const [key, value] of Object.entries(source)) {
    if (value > (target[key] ?? 0)) {
      target[key] = value;
    }
  }
}

/** maxUnionMarkers: merged copy when remote adds/advances, else null. */
function maxUnionMarkers(
  local: Record<string, number>,
  remote: Record<string, number>,
): Record<string, number> | null {
  let merged: Record<string, number> | null = null;
  for (const [key, value] of Object.entries(remote)) {
    if (!isIntegerTimestamp(value)) {
      continue;
    }
    const current = local[key];
    if (current !== undefined && value <= current) {
      continue;
    }
    if (merged === null) {
      merged = { ...local };
    }
    merged[key] = value;
  }
  return merged;
}

function plaintextByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}
