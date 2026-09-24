/**
 * Minimal PNG chunk surgery for `.agent.png` snapshot export — the web side
 * of `agent_snapshot.rs` `encode_chunk_payload_png`. The manifest rides a
 * `buzz_agent_snapshot` tEXt chunk inserted IMMEDIATELY AFTER IHDR: the
 * desktop's Rust decoder reads text chunks in `read_info()`, i.e. before the
 * first IDAT, so a chunk placed after IDAT would be invisible to it. Image
 * data is never re-encoded here — chunks are copied byte-for-byte. Pure.
 */

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
export const SNAPSHOT_KEYWORD = "buzz_agent_snapshot";
/** agent_snapshot.rs MAX_PNG_BODY_EDGE. */
export const MAX_PNG_BODY_EDGE = 512;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** Standard CRC-32 (PNG / zlib polynomial). */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    out[i] = text.charCodeAt(i) & 0xff;
  }
  return out;
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

/** Serialize one chunk: length, type, data, CRC(type+data). */
export function makeChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(ascii(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export interface PngChunk {
  type: string;
  /** The whole serialized chunk (length + type + data + crc). */
  raw: Uint8Array;
  data: Uint8Array;
}

/** Split a PNG into chunks; null when the signature or framing is invalid. */
export function pngChunks(bytes: Uint8Array): PngChunk[] | null {
  if (bytes.length < 8 || SIGNATURE.some((b, i) => bytes[i] !== b)) {
    return null;
  }
  const chunks: PngChunk[] = [];
  let offset = 8;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) {
      return null;
    }
    const length = readU32(bytes, offset);
    const end = offset + 12 + length;
    if (end > bytes.length) {
      return null;
    }
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    chunks.push({
      type,
      raw: bytes.subarray(offset, end),
      data: bytes.subarray(offset + 8, offset + 8 + length),
    });
    offset = end;
    if (type === "IEND") {
      break;
    }
  }
  if (chunks.length === 0 || chunks[0].type !== "IHDR") {
    return null;
  }
  return chunks;
}

/** IHDR width/height, or null for a non-PNG. */
export function pngDimensions(
  bytes: Uint8Array,
): { width: number; height: number } | null {
  const chunks = pngChunks(bytes);
  if (!chunks || chunks[0].data.length < 8) {
    return null;
  }
  return {
    width: readU32(chunks[0].data, 0),
    height: readU32(chunks[0].data, 4),
  };
}

function isSnapshotTextChunk(chunk: PngChunk): boolean {
  if (chunk.type !== "tEXt" && chunk.type !== "zTXt" && chunk.type !== "iTXt") {
    return false;
  }
  const keyword = ascii(SNAPSHOT_KEYWORD);
  return (
    chunk.data.length > keyword.length &&
    keyword.every((b, i) => chunk.data[i] === b) &&
    chunk.data[keyword.length] === 0
  );
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Insert `buzz_agent_snapshot` tEXt right after IHDR, stripping any prior
 * snapshot text chunk (tEXt/zTXt/iTXt). Throws on a malformed PNG.
 */
export function injectSnapshotText(
  png: Uint8Array,
  base64Json: string,
): Uint8Array {
  const chunks = pngChunks(png);
  if (!chunks) {
    throw new Error("Invalid PNG.");
  }
  const text = makeChunk(
    "tEXt",
    concat([ascii(SNAPSHOT_KEYWORD), new Uint8Array([0]), ascii(base64Json)]),
  );
  const kept = chunks.filter((chunk) => !isSnapshotTextChunk(chunk));
  return concat([
    new Uint8Array(SIGNATURE),
    kept[0].raw,
    text,
    ...kept.slice(1).map((chunk) => chunk.raw),
  ]);
}

/**
 * 1×1 RGBA [0,0,0,0] — the desktop's placeholder body, which import ignores
 * (`snapshot_avatar.rs`). IDAT is a zlib stored block over the one
 * scanline (filter 0 + 4 zero bytes), adler32 = 0x00050001.
 */
export const PLACEHOLDER_PNG: Uint8Array = concat([
  new Uint8Array(SIGNATURE),
  makeChunk(
    "IHDR",
    new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
  ),
  makeChunk(
    "IDAT",
    new Uint8Array([
      0x78, 0x01, 0x01, 0x05, 0x00, 0xfa, 0xff, 0, 0, 0, 0, 0, 0x00, 0x05,
      0x00, 0x01,
    ]),
  ),
  makeChunk("IEND", new Uint8Array(0)),
]);

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * Compose the `.agent.png`: the avatar PNG as the body when it is a PNG with
 * both edges <= 512 (the caller transcodes other avatars to such a PNG
 * first), otherwise the 1×1 placeholder.
 */
export function encodeSnapshotPng(
  json: Uint8Array,
  avatarPng: Uint8Array | null,
): Uint8Array {
  const text = base64(json);
  if (avatarPng && avatarPng.length > 0) {
    const dims = pngDimensions(avatarPng);
    if (
      dims &&
      dims.width > 0 &&
      dims.height > 0 &&
      dims.width <= MAX_PNG_BODY_EDGE &&
      dims.height <= MAX_PNG_BODY_EDGE
    ) {
      try {
        return injectSnapshotText(avatarPng, text);
      } catch {
        // fall through to the placeholder, like the desktop's Err arm
      }
    }
  }
  return injectSnapshotText(PLACEHOLDER_PNG, text);
}
