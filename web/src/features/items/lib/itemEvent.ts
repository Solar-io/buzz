/**
 * Items — bug and backlog entries (kind 30623), web half of redesign Phase 5.
 *
 * The wire format is fixed by `docs/plans/2026-09-29-web-redesign/phase-5.md`
 * and implemented once in Rust (`crates/buzz-core/src/item.rs`: the relay's
 * ingest validator and the fold; `crates/buzz-sdk/src/items.rs`: the
 * builder). This module MIRRORS both, so an item the web builds is one the
 * relay accepts, and the web folds heads exactly as the CLI does. When a rule
 * changes there, it changes here — the unit suite pins the same literals the
 * Rust tests do.
 *
 * Import-free (type imports only), so `node --test` loads it.
 */

export const KIND_ITEM = 30623;

export const ITEM_TYPES = ["bug", "backlog"] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export const ITEM_STATUSES = ["open", "progress", "needs-you", "done"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

/** Lowercase Crockford base32 — no i, l, o, u (`ITEM_ID_ALPHABET`). */
export const ITEM_ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
export const ITEM_ID_LEN = 12;
/** The display id is the first five characters (D5.8). */
export const ITEM_SHORT_LEN = 5;
export const ITEM_TITLE_MAX_CHARS = 200;
export const ITEM_SUMMARY_MAX_CHARS = 500;
export const ITEM_PROJECT_NAME_MAX_CHARS = 80;
export const ITEM_BODY_MAX_BYTES = 16 * 1024;
export const ITEM_CREATED_MAX_SKEW_SECS = 600;

const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SINGLE_VALUED = [
  "d",
  "h",
  "type",
  "status",
  "title",
  "summary",
  "created",
  "e",
  "a",
  "project",
];

/**
 * Rust's `str::trim` strips Unicode `White_Space` — NOT the set JS `trim`
 * strips (JS takes U+FEFF and not U+0085; Rust is the opposite; AGENTS.md
 * "the built-ins are the drift"). The title bound is counted after the RUST
 * trim (`item.rs` `validate_item_parts`), so the count is taken here over the
 * same set, spelled out.
 */
const RUST_WHITE_SPACE =
  "\\u0009-\\u000d\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const RUST_TRIM = new RegExp(
  `^[${RUST_WHITE_SPACE}]+|[${RUST_WHITE_SPACE}]+$`,
  "g",
);

/** `s.trim()` as Rust computes it. */
export function rustTrim(value: string): string {
  return value.replace(RUST_TRIM, "");
}

/** Unicode scalar count — Rust's `chars().count()`. */
export function charCount(value: string): number {
  return [...value].length;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function isValidItemId(value: string): boolean {
  if (value.length !== ITEM_ID_LEN) {
    return false;
  }
  for (const character of value) {
    if (!ITEM_ID_ALPHABET.includes(character)) {
      return false;
    }
  }
  return true;
}

/**
 * The relay's verdict on an item's parts, as `validate_item_parts` words it:
 * null when valid, else the rule (the relay prefixes `invalid: item: `).
 *
 * `nowS` bounds the `created` tag's future skew. Pass `Infinity` to skip that
 * one clock-dependent rule — a head the relay already accepted must not
 * become unreadable because this browser's clock runs slow.
 */
export function validateItemParts(
  kind: number,
  content: string,
  tags: readonly (readonly string[])[],
  nowS: number,
): string | null {
  if (kind !== KIND_ITEM) {
    return `wrong kind ${kind}, expected ${KIND_ITEM}`;
  }
  if (utf8Bytes(content) > ITEM_BODY_MAX_BYTES) {
    return `body exceeds ${ITEM_BODY_MAX_BYTES} bytes (got ${utf8Bytes(content)})`;
  }
  const single = new Map<string, readonly string[]>();
  let reporters = 0;
  let owners = 0;
  for (const tag of tags) {
    const name = tag[0];
    if (name === undefined) {
      continue;
    }
    if (SINGLE_VALUED.includes(name)) {
      if (single.has(name)) {
        return `duplicate ${name} tag`;
      }
      single.set(name, tag);
    }
    if (name === "p") {
      if (!HEX64.test(tag[1] ?? "")) {
        return "p tag must be a 64-char lowercase hex pubkey";
      }
      if (tag[3] === "reporter") {
        reporters += 1;
      } else if (tag[3] === "owner") {
        owners += 1;
      } else {
        return "p tag must carry role reporter or owner";
      }
    }
  }
  if (reporters !== 1) {
    return `exactly one reporter p tag required (got ${reporters})`;
  }
  if (owners > 1) {
    return `at most one owner p tag (got ${owners})`;
  }
  const tagValue = (name: string): string | undefined => single.get(name)?.[1];

  const d = tagValue("d");
  if (d === undefined) {
    return "missing d tag";
  }
  if (!isValidItemId(d)) {
    return "d must be 12 lowercase Crockford base32 characters";
  }
  // h is optional, but a non-UUID h would store the item as GLOBAL at the
  // relay (phase-5 risk R1) — a private bug made community-readable.
  if (single.has("h") && !UUID.test(single.get("h")?.[1] ?? "")) {
    return "h must be a lowercase hyphenated channel UUID";
  }
  const type = tagValue("type");
  if (type === undefined) {
    return "missing type tag";
  }
  if (!(ITEM_TYPES as readonly string[]).includes(type)) {
    return `type must be bug or backlog (got ${JSON.stringify(type)})`;
  }
  const status = tagValue("status");
  if (status === undefined) {
    return "missing status tag";
  }
  if (!(ITEM_STATUSES as readonly string[]).includes(status)) {
    return `status must be open, progress, needs-you or done (got ${JSON.stringify(status)})`;
  }
  const title = tagValue("title");
  if (title === undefined) {
    return "missing title tag";
  }
  const titleChars = charCount(rustTrim(title));
  if (titleChars === 0 || titleChars > ITEM_TITLE_MAX_CHARS) {
    return `title must be 1..=${ITEM_TITLE_MAX_CHARS} characters (got ${titleChars})`;
  }
  const summary = tagValue("summary");
  if (summary !== undefined && charCount(summary) > ITEM_SUMMARY_MAX_CHARS) {
    return `summary exceeds ${ITEM_SUMMARY_MAX_CHARS} characters (got ${charCount(summary)})`;
  }
  const created = tagValue("created");
  if (created === undefined) {
    return "missing created tag";
  }
  if (!/^\d+$/.test(created)) {
    return "created must be unix seconds";
  }
  if (Number(created) > nowS + ITEM_CREATED_MAX_SKEW_SECS) {
    return "created is too far in the future";
  }
  const e = single.get("e");
  if (e) {
    if (!HEX64.test(e[1] ?? "")) {
      return "e tag must be a 64-char lowercase hex event id";
    }
    if (e[3] !== "source") {
      return "e tag must carry marker source";
    }
  }
  const a = tagValue("a");
  if (a !== undefined) {
    const [kindPart, pubkey, ...rest] = a.split(":");
    if (
      kindPart !== "30621" ||
      !HEX64.test(pubkey ?? "") ||
      rest.join(":") === ""
    ) {
      return "a must be a 30621:<pubkey>:<d> project coordinate";
    }
  }
  const project = tagValue("project");
  if (
    project !== undefined &&
    charCount(project) > ITEM_PROJECT_NAME_MAX_CHARS
  ) {
    return `project exceeds ${ITEM_PROJECT_NAME_MAX_CHARS} characters (got ${charCount(project)})`;
  }
  return null;
}

/** The slice of a signed event the item code reads. */
export interface ItemSourceEvent {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  content: string;
  tags: string[][];
}

/** The folded, current state of one item (`ItemHead` in `item.rs`). */
export interface ItemHead {
  /** Item id (`d`). */
  id: string;
  /** Source channel (`h`), or null for a community-global item. */
  channelId: string | null;
  type: ItemType;
  status: ItemStatus;
  title: string;
  summary: string | null;
  /** Markdown body (event content). */
  body: string;
  /** Unix seconds first filed; copied forward on every edit. */
  created: number;
  reporter: string;
  owner: string | null;
  sourceEventId: string | null;
  projectCoordinate: string | null;
  projectName: string | null;
  /** `created_at` of the winning head. */
  updatedAt: number;
  /** Author of the winning head. */
  updatedBy: string;
  /** Event id of the winning head. */
  eventId: string;
}

/** Parse one head, or null when the relay would not have accepted it. */
export function parseItemEvent(
  event: ItemSourceEvent,
  nowS = Number.POSITIVE_INFINITY,
): ItemHead | null {
  if (validateItemParts(event.kind, event.content, event.tags, nowS) !== null) {
    return null;
  }
  const head: ItemHead = {
    id: "",
    channelId: null,
    type: "bug",
    status: "open",
    title: "",
    summary: null,
    body: event.content,
    created: 0,
    reporter: "",
    owner: null,
    sourceEventId: null,
    projectCoordinate: null,
    projectName: null,
    updatedAt: event.created_at,
    updatedBy: event.pubkey,
    eventId: event.id,
  };
  for (const tag of event.tags) {
    const value = tag[1];
    if (value === undefined) {
      continue;
    }
    switch (tag[0]) {
      case "d":
        head.id = value;
        break;
      case "h":
        head.channelId = value;
        break;
      case "type":
        head.type = value as ItemType;
        break;
      case "status":
        head.status = value as ItemStatus;
        break;
      case "title":
        head.title = value;
        break;
      case "summary":
        head.summary = value;
        break;
      case "created":
        head.created = Number(value);
        break;
      case "e":
        head.sourceEventId = value;
        break;
      case "a":
        head.projectCoordinate = value;
        break;
      case "project":
        head.projectName = value;
        break;
      case "p":
        if (tag[3] === "reporter") {
          head.reporter = value;
        } else if (tag[3] === "owner") {
          head.owner = value;
        }
        break;
    }
  }
  return head;
}

/** The fold key: `(h or "", d)` — `h` is part of an item's identity (D5.5). */
export function itemKey(channelId: string | null, d: string): string {
  return `${channelId ?? ""}|${d}`;
}

/** `(author, 30623, d)` + `h`: one author's head for one item. */
export function headKey(event: ItemSourceEvent): string {
  let h = "";
  let d = "";
  for (const tag of event.tags) {
    if (tag[0] === "h" && h === "") {
      h = tag[1] ?? "";
    } else if (tag[0] === "d" && d === "") {
      d = tag[1] ?? "";
    }
  }
  return `${event.pubkey}|${h}|${d}`;
}

/** NIP-01: newer `created_at` wins; on a tie the LOWEST id wins. */
export function supersedes(
  candidate: { created_at: number; id: string },
  current: { created_at: number; id: string },
): boolean {
  if (candidate.created_at !== current.created_at) {
    return candidate.created_at > current.created_at;
  }
  return candidate.id < current.id;
}

/**
 * Fold heads into current items (`fold_items` in `item.rs`): group by
 * `(h, d)`, keep the newest head, skip anything invalid. Output order is
 * newest `updatedAt` first, then id — callers re-sort for display.
 */
export function foldItems(events: Iterable<ItemSourceEvent>): ItemHead[] {
  const winners = new Map<string, { event: ItemSourceEvent; head: ItemHead }>();
  for (const event of events) {
    const head = parseItemEvent(event);
    if (!head) {
      continue;
    }
    const key = itemKey(head.channelId, head.id);
    const current = winners.get(key);
    if (!current || supersedes(event, current.event)) {
      winners.set(key, { event, head });
    }
  }
  return [...winners.values()]
    .map((entry) => entry.head)
    .sort(
      (a, b) =>
        b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}

/** A fresh item id: 12 Crockford characters from 60 random bits. */
export function newItemId(
  random: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array = (bytes) =>
    crypto.getRandomValues(bytes),
): string {
  const bytes = random(new Uint8Array(ITEM_ID_LEN));
  let out = "";
  for (const byte of bytes) {
    out += ITEM_ID_ALPHABET[byte & 0x1f];
  }
  return out;
}

export function shortItemId(d: string): string {
  return d.slice(0, ITEM_SHORT_LEN);
}

export function itemCoordinate(pubkey: string, d: string): string {
  return `${KIND_ITEM}:${pubkey}:${d}`;
}

/** `created_at` for a read-modify-write: `max(now, prev + 1)`. */
export function nextCreatedAt(prev: number | null, nowS: number): number {
  return prev === null ? nowS : Math.max(nowS, prev + 1);
}

/** Everything one head carries (`ItemDraft` in `buzz-sdk`). */
export interface ItemDraft {
  d: string;
  channelId: string | null;
  type: ItemType;
  status: ItemStatus;
  title: string;
  summary: string | null;
  body: string;
  created: number;
  reporter: string;
  owner: string | null;
  sourceEventId: string | null;
  projectCoordinate: string | null;
  projectName: string | null;
}

/** The raw tags for `draft`, in the SDK's wire order. */
export function itemTags(draft: ItemDraft): string[][] {
  const tags: string[][] = [["d", draft.d]];
  if (draft.channelId !== null) {
    tags.push(["h", draft.channelId]);
  }
  tags.push(["type", draft.type]);
  tags.push(["status", draft.status]);
  tags.push(["title", rustTrim(draft.title)]);
  if (draft.summary !== null) {
    tags.push(["summary", draft.summary]);
  }
  tags.push(["created", String(draft.created)]);
  tags.push(["p", draft.reporter, "", "reporter"]);
  if (draft.owner !== null) {
    tags.push(["p", draft.owner, "", "owner"]);
  }
  if (draft.sourceEventId !== null) {
    tags.push(["e", draft.sourceEventId, "", "source"]);
  }
  if (draft.projectCoordinate !== null) {
    tags.push(["a", draft.projectCoordinate]);
  }
  if (draft.projectName !== null) {
    tags.push(["project", draft.projectName]);
  }
  return tags;
}

/**
 * The unsigned head for `draft`, self-checked against the relay's rules
 * (`build_item`): a draft the relay would refuse never reaches the signer.
 */
export function itemTemplate(
  draft: ItemDraft,
  createdAt: number,
  nowS: number,
):
  | {
      ok: true;
      template: {
        kind: number;
        tags: string[][];
        content: string;
        created_at: number;
      };
    }
  | { ok: false; error: string } {
  const tags = itemTags(draft);
  const rejection = validateItemParts(KIND_ITEM, draft.body, tags, nowS);
  if (rejection !== null) {
    return { ok: false, error: rejection };
  }
  return {
    ok: true,
    template: {
      kind: KIND_ITEM,
      tags,
      content: draft.body,
      created_at: createdAt,
    },
  };
}

export type ItemPatch = Partial<
  Pick<
    ItemDraft,
    | "type"
    | "status"
    | "title"
    | "summary"
    | "body"
    | "owner"
    | "projectName"
    | "projectCoordinate"
  >
>;

/**
 * The next head for an edit: the patch over the winner, with the identity
 * tags — `h`, `created`, reporter and the source `e` — copied forward
 * unchanged (`update_copies_identity_tags_forward`).
 */
export function editDraft(head: ItemHead, patch: ItemPatch): ItemDraft {
  return {
    d: head.id,
    channelId: head.channelId,
    type: patch.type ?? head.type,
    status: patch.status ?? head.status,
    title: patch.title ?? head.title,
    summary: patch.summary !== undefined ? patch.summary : head.summary,
    body: patch.body ?? head.body,
    created: head.created,
    reporter: head.reporter,
    owner: patch.owner !== undefined ? patch.owner : head.owner,
    sourceEventId: head.sourceEventId,
    projectCoordinate:
      patch.projectCoordinate !== undefined
        ? patch.projectCoordinate
        : head.projectCoordinate,
    projectName:
      patch.projectName !== undefined ? patch.projectName : head.projectName,
  };
}
