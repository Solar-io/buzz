/**
 * `buzz share` on the wire (phase-6.md "Wire format — a share"): an ordinary
 * kind 9 message carrying one `imeta` per file, the `["t","shelf"]` marker,
 * and — unless `--no-path` — one `["path","<host>:<abs path>"]` per file in
 * the same order as the imeta tags.
 *
 * Nothing here trusts the content: filenames come from `imeta` (the CLI
 * writes `filename <basename>`), and the summary is the message prose with
 * the attachment links taken out.
 *
 * Pure and import-free of React so `node --test` loads it directly.
 */

import { parseImetaEntry } from "@/features/channels/lib/imetaEntries.ts";
import { type FileKind, fileKind } from "./fileKind.ts";
import { fileTabKey, type OpenFile } from "./fileTabs.ts";

/** The `t` tag value that puts a message on the Shelf. */
export const SHELF_TOPIC = "shelf";

/** Kinds a share can be: the CLI publishes stream messages (kind 9). */
export const SHARE_KINDS = [9];

export interface SharePath {
  /** The short hostname the CLI stamped (`crichton`). */
  host: string;
  /** Absolute path on that host. */
  path: string;
}

export interface ShareFile {
  url: string;
  filename: string;
  mime: string | null;
  size: number | null;
  sha256: string | null;
  dim: string | null;
  kind: FileKind;
  path: SharePath | null;
}

export interface Share {
  id: string;
  channelId: string;
  authorPubkey: string;
  createdAt: number;
  /** The message prose with the attachment links removed ("" for none). */
  summary: string;
  files: ShareFile[];
  /** NIP-10 root / parent, when the share itself was posted as a reply. */
  rootId: string | null;
  replyToId: string | null;
}

interface RawEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}

const HOST = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what a path must not carry
const CONTROL = /[\u0000-\u001f\u007f]/;

/** `crichton:/Users/sam/x.md` → `{host, path}`, or null for anything else. */
export function parseSharePath(value: unknown): SharePath | null {
  if (typeof value !== "string" || value.length > 4200) {
    return null;
  }
  const colon = value.indexOf(":");
  if (colon <= 0) {
    return null;
  }
  const host = value.slice(0, colon);
  const path = value.slice(colon + 1);
  if (!HOST.test(host) || !path.startsWith("/") || CONTROL.test(path)) {
    return null;
  }
  return { host, path };
}

/** The message carries the Shelf marker. */
export function isShelfShare(tags: readonly string[][]): boolean {
  return tags.some((tag) => tag[0] === "t" && tag[1] === SHELF_TOPIC);
}

/** Raw `path` tag values, in order (the timeline keeps these per message). */
export function sharePathValues(tags: readonly string[][]): string[] {
  return tags
    .filter((tag) => tag[0] === "path" && typeof tag[1] === "string")
    .map((tag) => tag[1]);
}

/**
 * Pair paths with files. The CLI emits one per file in imeta order; anything
 * else (a hand-built event, a partial `--no-path`) cannot be paired by
 * position, so it pairs nothing — a wrong "Open in Files" is worse than none.
 * One file with one path is unambiguous either way.
 */
export function pairPaths(
  fileCount: number,
  values: readonly string[],
): (SharePath | null)[] {
  if (values.length !== fileCount) {
    return Array.from({ length: fileCount }, () => null);
  }
  return values.map((value) => parseSharePath(value));
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The prose around the attachment links, whitespace collapsed. */
export function shareSummary(content: string, urls: readonly string[]): string {
  let text = content;
  for (const url of urls) {
    text = text.replace(
      new RegExp(`!?\\[[^\\]\\n]*\\]\\(${escapeForRegExp(url)}\\)`, "g"),
      " ",
    );
  }
  return text.replace(/\s+/g, " ").trim();
}

function urlTail(url: string): string {
  const tail = url.split(/[?#]/)[0].split("/").pop() ?? "";
  return tail === "" ? "file" : tail;
}

/** The link label the content gives a URL, if any (`[report.md](url)`). */
function linkLabel(content: string, url: string): string | null {
  const match = new RegExp(
    `\\[([^\\]\\n]{1,255})\\]\\(${escapeForRegExp(url)}\\)`,
  ).exec(content);
  if (!match) {
    return null;
  }
  const label = match[1].trim();
  return label === "" || label === "image" || label === "video" ? null : label;
}

/** NIP-10 root / reply markers, the timeline's own rule. */
function threadMarkers(tags: readonly string[][]): {
  rootId: string | null;
  replyToId: string | null;
} {
  let rootId: string | null = null;
  let replyToId: string | null = null;
  for (const tag of tags) {
    if (tag[0] !== "e" || typeof tag[1] !== "string") {
      continue;
    }
    if (tag[3] === "root") {
      rootId = tag[1];
    } else if (tag[3] === "reply") {
      replyToId = tag[1];
    }
  }
  if (!rootId && !replyToId) {
    replyToId = tags.find((tag) => tag[0] === "e")?.[1] ?? null;
  }
  return { rootId, replyToId };
}

/** One share, or null for anything that is not one. */
export function parseShare(event: RawEvent): Share | null {
  if (!SHARE_KINDS.includes(event.kind) || !isShelfShare(event.tags)) {
    return null;
  }
  const channelId = event.tags.find((tag) => tag[0] === "h")?.[1];
  if (typeof channelId !== "string" || channelId === "") {
    return null;
  }
  const seen = new Set<string>();
  const entries = event.tags
    .map((tag) => parseImetaEntry(tag))
    .filter((entry) => {
      if (entry === null || seen.has(entry.url)) {
        return false;
      }
      seen.add(entry.url);
      return true;
    });
  if (entries.length === 0) {
    return null;
  }
  const paths = pairPaths(entries.length, sharePathValues(event.tags));
  const files = entries.map((entry, index): ShareFile => {
    if (entry === null) {
      throw new Error("unreachable: filtered above");
    }
    const filename =
      entry.filename?.trim() ||
      linkLabel(event.content, entry.url) ||
      urlTail(entry.url);
    return {
      url: entry.url,
      filename,
      mime: entry.m ?? null,
      size: entry.size ?? null,
      sha256: entry.x ?? null,
      dim: entry.dim ?? null,
      kind: fileKind(filename, entry.m),
      path: paths[index] ?? null,
    };
  });
  return {
    id: event.id,
    channelId,
    authorPubkey: event.pubkey,
    createdAt: event.created_at,
    summary: shareSummary(
      event.content,
      files.map((file) => file.url),
    ),
    files,
    ...threadMarkers(event.tags),
  };
}

/** What a file tab holds for one file of a share. */
export function openFileOf(share: Share, file: ShareFile): OpenFile {
  return {
    key: fileTabKey(share.id, file.url),
    url: file.url,
    filename: file.filename,
    mime: file.mime,
    size: file.size,
    channelId: share.channelId,
    messageId: share.id,
    authorPubkey: share.authorPubkey,
    createdAt: share.createdAt,
    rootId: share.rootId,
    replyToId: share.replyToId,
    path: file.path ? `${file.path.host}:${file.path.path}` : null,
  };
}

/**
 * Where a comment on a share goes: a thread reply whose ROOT is the share's
 * thread root (AGENTS.md "Thread ancestry" — the relay rejects a self-rooted
 * reply) and whose parent is the share itself.
 */
export function commentThreadRef(message: {
  id: string;
  rootId: string | null;
  replyToId: string | null;
}): { rootId: string; replyToId: string } {
  return {
    rootId: message.rootId ?? message.replyToId ?? message.id,
    replyToId: message.id,
  };
}

/** `/Users/sam/a/b.md` → `~/a/b.md` (and `/home/sam/…` on Linux). */
export function displayPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
}

/** The folder a path lives in (no trailing slash; "/" for the root). */
export function dirOf(path: string): string {
  const cut = path.replace(/\/+$/, "").lastIndexOf("/");
  return cut <= 0 ? "/" : path.slice(0, cut);
}

/**
 * The one folder every file came from, or null when they differ (or any file
 * has no path). The tile group's header names it.
 */
export function commonFolder(
  paths: readonly (SharePath | null)[],
): SharePath | null {
  if (paths.length === 0 || paths.some((path) => path === null)) {
    return null;
  }
  const first = paths[0] as SharePath;
  const folder = dirOf(first.path);
  for (const path of paths) {
    if (path?.host !== first.host || dirOf(path.path) !== folder) {
      return null;
    }
  }
  return { host: first.host, path: folder };
}

/** `~/MEGA/shared/rts` → ["MEGA", "shared", "rts"] (at most the last four). */
export function folderCrumbs(path: string): string[] {
  const parts = displayPath(path)
    .split("/")
    .filter((part) => part !== "" && part !== "~");
  return parts.slice(-4);
}

function commonPrefix(values: readonly string[]): string {
  let prefix = values[0] ?? "";
  for (const value of values) {
    while (!value.startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
    }
  }
  return prefix;
}

function commonSuffix(values: readonly string[]): string {
  const reversed = values.map((value) => [...value].reverse().join(""));
  return [...commonPrefix(reversed)].reverse().join("");
}

/**
 * What tells the files of one share apart: `game-A.html … game-D.html` →
 * ["A","B","C","D"], or null when the names share no frame (or the parts are
 * empty or long). A tile shows its part as the thumbnail.
 */
export function distinguishingParts(
  filenames: readonly string[],
): string[] | null {
  if (filenames.length < 2) {
    return null;
  }
  const prefix = commonPrefix(filenames);
  const suffix = commonSuffix(
    filenames.map((name) => name.slice(prefix.length)),
  );
  if (prefix === "" && suffix === "") {
    return null;
  }
  const parts = filenames.map((name) =>
    name.slice(prefix.length, name.length - suffix.length),
  );
  if (parts.some((part) => part === "" || part.length > 3)) {
    return null;
  }
  return parts;
}

/**
 * One Shelf row for a multi-file share: `game-A…D.html`, or `4 files` when
 * the names share no frame.
 */
export function compressedNames(filenames: readonly string[]): string {
  if (filenames.length === 1) {
    return filenames[0];
  }
  const parts = distinguishingParts(filenames);
  if (!parts) {
    return `${filenames.length} files`;
  }
  const first = filenames[0];
  const prefix = commonPrefix(filenames);
  const suffix = first.slice(prefix.length + parts[0].length);
  return `${prefix}${parts[0]}…${parts[parts.length - 1]}${suffix}`;
}

/**
 * The absolute path "Open in Files" can open, or null. The path's host must
 * be the host the Files panel serves (its URL's first DNS label, or the whole
 * hostname): a path on another machine would open the wrong disk.
 */
export function filesTarget(
  path: SharePath | null,
  filesUrl: string,
): string | null {
  if (!path || filesUrl === "") {
    return null;
  }
  let hostname: string;
  try {
    hostname = new URL(filesUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  const host = path.host.toLowerCase();
  if (hostname !== host && hostname.split(".")[0] !== host) {
    return null;
  }
  return path.path;
}
