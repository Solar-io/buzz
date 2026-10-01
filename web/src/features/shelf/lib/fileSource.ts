/**
 * The message a file tile sits in, as the tile needs it to open the file in
 * a tab: which conversation and message (comments are replies to it), who
 * shared it and when, whether it is a Shelf share, and its `path` tags.
 *
 * Built once per message row and handed to the markdown renderer, so the
 * tiles deep inside it never reach back up for the event.
 *
 * Pure so `node --test` loads it directly.
 */

import { fileTabKey, type OpenFile } from "./fileTabs.ts";
import { pairPaths, type SharePath } from "./shareEvent.ts";

export interface FileSource {
  channelId: string;
  messageId: string;
  authorPubkey: string;
  createdAt: number;
  rootId: string | null;
  replyToId: string | null;
  /** Carries `["t","shelf"]`. */
  shelf: boolean;
  /** Attachment URLs in imeta order, for pairing `paths`. */
  urls: readonly string[];
  /** Raw `path` tag values, in imeta order. */
  paths: readonly string[];
}

/** The fields of a timeline message this reads (kept structural for tests). */
export interface FileSourceMessage {
  id: string;
  channelId: string;
  authorPubkey: string;
  createdAt: number;
  rootId: string | null;
  replyToId: string | null;
  imetaByUrl: ReadonlyMap<string, unknown>;
  /** Absent on rows cached before Phase 6 — read it with `!= null`. */
  shelf?: { paths: string[] } | null;
}

export function fileSourceOf(message: FileSourceMessage): FileSource {
  return {
    channelId: message.channelId,
    messageId: message.id,
    authorPubkey: message.authorPubkey,
    createdAt: message.createdAt,
    rootId: message.rootId,
    replyToId: message.replyToId,
    shelf: message.shelf != null,
    urls: [...message.imetaByUrl.keys()],
    paths: message.shelf?.paths ?? [],
  };
}

/** The path a share recorded for one of its files, or null. */
export function sourcePath(
  source: FileSource | null,
  url: string,
): SharePath | null {
  if (!source || source.paths.length === 0) {
    return null;
  }
  const index = source.urls.indexOf(url);
  if (index === -1) {
    return null;
  }
  return pairPaths(source.urls.length, source.paths)[index] ?? null;
}

/** The tab for a tile's file. Without a source it is a bare file (no thread). */
export function openFileFromSource(
  source: FileSource | null,
  file: { href: string; filename: string; size?: number; mime?: string | null },
): OpenFile {
  const path = sourcePath(source, file.href);
  return {
    key: fileTabKey(source?.messageId ?? null, file.href),
    url: file.href,
    filename: file.filename,
    mime: file.mime ?? null,
    size: file.size ?? null,
    channelId: source?.channelId ?? null,
    messageId: source?.messageId ?? null,
    authorPubkey: source?.authorPubkey ?? null,
    createdAt: source?.createdAt ?? null,
    rootId: source?.rootId ?? null,
    replyToId: source?.replyToId ?? null,
    path: path ? `${path.host}:${path.path}` : null,
  };
}
