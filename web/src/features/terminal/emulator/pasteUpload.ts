/**
 * Paste into the terminal: the pure half. Rewritten from evie-ui
 * `term-paste-upload.js` (+ the naming helpers from `fs-upload.js`), with the
 * Sidedrop upload replaced by an injected `upload(file) → absolute path`
 * that POSTs to hatch `/api/term/upload` (phase-7.md §5.5).
 *
 * Two jobs:
 *  1. ADR-101 — split an oversized bracketed paste into several complete
 *     bracketed frames. One giant frame stalls the PTY write drain; a split
 *     that loses the closing `ESC[201~` leaves the shell stuck in paste mode.
 *  2. A FILE on the clipboard is uploaded to crichton and its absolute path
 *     typed at the prompt as a bracketed paste, so Claude Code attaches an
 *     image (or gets the path as text). A TEXT paste is never touched.
 */

export const BP_START = "\x1b[200~";
export const BP_END = "\x1b[201~";

/** One WebSocket frame never carries more than this much of a bracketed paste. */
export const MAX_BRACKETED_PASTE_FRAME_BYTES = 512 * 1024;

const encoder = new TextEncoder();
const BP_START_BYTES = encoder.encode(BP_START);
const BP_END_BYTES = encoder.encode(BP_END);
const MAX_PAYLOAD_BYTES =
  MAX_BRACKETED_PASTE_FRAME_BYTES - BP_START_BYTES.length - BP_END_BYTES.length;

function hasPrefix(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}

function hasSuffix(bytes: Uint8Array, suffix: Uint8Array): boolean {
  if (bytes.length < suffix.length) return false;
  const offset = bytes.length - suffix.length;
  for (let i = 0; i < suffix.length; i++) {
    if (bytes[offset + i] !== suffix[i]) return false;
  }
  return true;
}

const isContinuation = (byte: number) => (byte & 0xc0) === 0x80;

function bracketedFrame(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(
    BP_START_BYTES.length + payload.length + BP_END_BYTES.length,
  );
  frame.set(BP_START_BYTES);
  frame.set(payload, BP_START_BYTES.length);
  frame.set(BP_END_BYTES, BP_START_BYTES.length + payload.length);
  return frame;
}

/**
 * Split a bracketed paste bigger than one frame into several COMPLETE
 * bracketed frames, never cutting a UTF-8 codepoint. Anything else (plain
 * keystrokes, a small paste, an unbracketed blob) goes out as one frame.
 */
export function splitOversizedBracketedPaste(bytes: Uint8Array): Uint8Array[] {
  if (
    bytes.length <= MAX_BRACKETED_PASTE_FRAME_BYTES ||
    !hasPrefix(bytes, BP_START_BYTES) ||
    !hasSuffix(bytes, BP_END_BYTES)
  ) {
    return [bytes];
  }
  const payload = bytes.subarray(
    BP_START_BYTES.length,
    bytes.length - BP_END_BYTES.length,
  );
  const frames: Uint8Array[] = [];
  let offset = 0;
  while (offset < payload.length) {
    let end = Math.min(offset + MAX_PAYLOAD_BYTES, payload.length);
    if (end < payload.length) {
      while (end > offset && isContinuation(payload[end] ?? 0)) end--;
      if (end === offset) return [bytes];
    }
    frames.push(bracketedFrame(payload.subarray(offset, end)));
    offset = end;
  }
  return frames;
}

/** Backslash-escape everything outside a conservative safe set. */
export function shellEscapePath(abs: string): string {
  return String(abs).replace(/[^A-Za-z0-9_@%+=:,./-]/g, (c) => `\\${c}`);
}

/** Each path as its own bracketed paste, space-separated. No CR: it is typed, not submitted. */
export function bracketedPaths(paths: readonly string[]): string {
  return paths.map((p) => BP_START + shellEscapePath(p) + BP_END).join(" ");
}

interface ClipboardLike {
  types?: ArrayLike<string> & { includes?(v: string): boolean };
  items?: ArrayLike<{ kind: string }>;
  files?: ArrayLike<File>;
}

/** Does the clipboard carry at least one FILE (not just text)? */
export function clipboardHasFiles(
  data: ClipboardLike | null | undefined,
): boolean {
  if (!data) return false;
  const types = data.types;
  if (types && Array.from(types).includes("Files")) return true;
  const items = data.items;
  if (items) {
    for (const item of Array.from(items)) {
      if (item.kind === "file") return true;
    }
  }
  return false;
}

const GENERIC_NAMES = new Set([
  "",
  "image",
  "image.png",
  "pasted",
  "blob",
  "file",
  "unknown",
]);

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
  "text/plain": "txt",
};

function extForMime(type: string | undefined): string {
  const mime =
    String(type ?? "")
      .split(";")[0]
      ?.trim()
      .toLowerCase() ?? "";
  if (MIME_EXT[mime]) return MIME_EXT[mime];
  const sub = mime.includes("/") ? mime.slice(mime.indexOf("/") + 1) : "";
  return /^[a-z0-9]{1,8}$/.test(sub) ? sub : "bin";
}

const p2 = (n: number) => String(n).padStart(2, "0");

/**
 * The name to upload a pasted file under: a real name is kept; a screenshot's
 * generic `image.png` becomes a sortable `pasted-2026-09-30T14-02-07.png`.
 */
export function pastedName(
  file: { name?: string; type?: string },
  index = 0,
  now = new Date(),
): string {
  const raw = String(file.name ?? "").trim();
  if (raw && !GENERIC_NAMES.has(raw.toLowerCase())) return raw;
  const stamp =
    `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}` +
    `T${p2(now.getHours())}-${p2(now.getMinutes())}-${p2(now.getSeconds())}`;
  return `pasted-${stamp}${index > 0 ? `-${index}` : ""}.${extForMime(file.type)}`;
}

export interface PasteOutcome {
  paths: string[];
  failed: Array<{ name: string; error: string }>;
  /** The bracketed text to type, or "" when nothing uploaded. */
  bytes: string;
}

/** Upload each file in turn, then build the paste. Never throws. */
export async function uploadAndBuildPaste(
  files: readonly File[],
  upload: (file: File, name: string) => Promise<string>,
  now = new Date(),
): Promise<PasteOutcome> {
  const paths: string[] = [];
  const failed: PasteOutcome["failed"] = [];
  for (const [index, file] of files.entries()) {
    const name = pastedName(file, index, now);
    try {
      paths.push(await upload(file, name));
    } catch (error) {
      failed.push({
        name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { paths, failed, bytes: paths.length ? bracketedPaths(paths) : "" };
}
