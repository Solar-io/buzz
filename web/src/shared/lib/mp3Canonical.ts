/**
 * MP3 tag stripping for the browser upload path — a line-for-line mirror of
 * `crates/buzz-media/src/mp3.rs` (`strip_mp3_tags` / `looks_like_mpeg_audio`).
 *
 * The relay stores exactly the bytes it receives (sha256-addressed) and
 * rejects an MP3 that still carries any tag block with `MetadataForbidden`
 * (422). So the client strips before hashing:
 *
 * - leading ID3v2 tags (repeated; v2.4 footer flag honoured),
 * - trailing ID3v1 (`TAG`, 128 bytes) + Enhanced `TAG+` (227 bytes before it),
 *   APEv2 (`APETAGEX` footer, optional header), Lyrics3v2 (`LYRICS200`), and
 *   ID3v2 appended at the tail (`3DI` footer),
 * - trailing zero padding after the last frame.
 *
 * What remains must be MPEG audio frames end to end from byte 0, with no
 * ID3v2 header anywhere inside. Anything else throws — the relay would refuse
 * it, and guessing at unknown bytes is how metadata leaks. Pure: no DOM.
 */

const ID3V2_HEADER_LEN = 10;
const ID3V1_LEN = 128;
const ID3V1_ENHANCED_LEN = 227;
const APE_FOOTER_LEN = 32;
const LYRICS3_END = "LYRICS200";
const LYRICS3_SIZE_DIGITS = 6;

const V1_L1 = [
  0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448,
];
const V1_L2 = [
  0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384,
];
const V1_L3 = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
];
const V2_L1 = [
  0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256,
];
const V2_L23 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const RATES: Record<number, readonly number[]> = {
  3: [44_100, 48_000, 32_000],
  2: [22_050, 24_000, 16_000],
  0: [11_025, 12_000, 8_000],
};

function ascii(bytes: Uint8Array, at: number, text: string): boolean {
  if (at < 0 || at + text.length > bytes.length) {
    return false;
  }
  for (let i = 0; i < text.length; i += 1) {
    if (bytes[at + i] !== text.charCodeAt(i)) {
      return false;
    }
  }
  return true;
}

/**
 * Length of the MPEG audio frame whose header starts at `at`, or null when
 * the 4 bytes there are not a walkable frame header (no `0xFFE` sync, a
 * reserved version/layer/rate/emphasis, bitrate index 15, or free-format).
 */
export function frameLength(bytes: Uint8Array, at = 0): number | null {
  if (at + 4 > bytes.length) {
    return null;
  }
  const b0 = bytes[at];
  const b1 = bytes[at + 1];
  const b2 = bytes[at + 2];
  const b3 = bytes[at + 3];
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) {
    return null;
  }
  const version = (b1 >> 3) & 0x03;
  const layer = (b1 >> 1) & 0x03;
  const bitrateIndex = b2 >> 4;
  const rateIndex = (b2 >> 2) & 0x03;
  const padding = (b2 >> 1) & 0x01;
  const emphasis = b3 & 0x03;
  if (
    version === 1 ||
    layer === 0 ||
    bitrateIndex === 0 ||
    bitrateIndex === 15 ||
    rateIndex === 3 ||
    emphasis === 2
  ) {
    return null;
  }
  const mpeg1 = version === 3;
  const table = mpeg1
    ? layer === 3
      ? V1_L1
      : layer === 2
        ? V1_L2
        : V1_L3
    : layer === 3
      ? V2_L1
      : V2_L23;
  const bitrate = table[bitrateIndex] * 1000;
  const sampleRate = RATES[version][rateIndex];
  let len: number;
  if (layer === 3) {
    len = (Math.floor((12 * bitrate) / sampleRate) + padding) * 4;
  } else if (layer === 2 || mpeg1) {
    len = Math.floor((144 * bitrate) / sampleRate) + padding;
  } else {
    len = Math.floor((72 * bitrate) / sampleRate) + padding;
  }
  return len >= 4 ? len : null;
}

/**
 * Whether `bytes` opens with MPEG audio frames: a valid header at 0 and, when
 * the buffer reaches it, a second valid header exactly one frame later.
 */
export function looksLikeMpegAudio(bytes: Uint8Array): boolean {
  const first = frameLength(bytes, 0);
  if (first === null) {
    return false;
  }
  if (bytes.length - first >= 4) {
    return frameLength(bytes, first) !== null;
  }
  return true;
}

function synchsafe(bytes: Uint8Array, at: number): number | null {
  if (at + 4 > bytes.length) {
    return null;
  }
  let value = 0;
  for (let i = 0; i < 4; i += 1) {
    const b = bytes[at + i];
    if (b >= 0x80) {
      return null;
    }
    value = value * 128 + b;
  }
  return value;
}

/** Structurally plausible ID3v2 header anywhere in `bytes`. */
export function containsId3v2Header(bytes: Uint8Array): boolean {
  for (let i = 0; i + ID3V2_HEADER_LEN <= bytes.length; i += 1) {
    if (
      bytes[i] === 0x49 &&
      bytes[i + 1] === 0x44 &&
      bytes[i + 2] === 0x33 &&
      bytes[i + 3] >= 2 &&
      bytes[i + 3] <= 4 &&
      bytes[i + 4] !== 0xff &&
      bytes[i + 6] < 0x80 &&
      bytes[i + 7] < 0x80 &&
      bytes[i + 8] < 0x80 &&
      bytes[i + 9] < 0x80
    ) {
      return true;
    }
  }
  return false;
}

function leadingId3v2Len(bytes: Uint8Array, at: number): number | null {
  if (at + ID3V2_HEADER_LEN > bytes.length || !ascii(bytes, at, "ID3")) {
    return null;
  }
  const body = synchsafe(bytes, at + 6);
  if (body === null) {
    return null;
  }
  const footer = (bytes[at + 5] & 0x10) !== 0 ? ID3V2_HEADER_LEN : 0;
  return ID3V2_HEADER_LEN + body + footer;
}

function u32le(bytes: Uint8Array, at: number): number {
  return (
    (bytes[at] |
      (bytes[at + 1] << 8) |
      (bytes[at + 2] << 16) |
      (bytes[at + 3] << 24)) >>>
    0
  );
}

/** Length of the one trailing tag block ending at `end`, or null. */
function trailingTagLen(
  bytes: Uint8Array,
  start: number,
  end: number,
): number | null {
  const len = end - start;
  if (len >= ID3V1_LEN && ascii(bytes, end - ID3V1_LEN, "TAG")) {
    const enhanced = end - ID3V1_LEN - ID3V1_ENHANCED_LEN;
    if (enhanced >= start && ascii(bytes, enhanced, "TAG+")) {
      return ID3V1_LEN + ID3V1_ENHANCED_LEN;
    }
    return ID3V1_LEN;
  }
  if (len >= APE_FOOTER_LEN && ascii(bytes, end - APE_FOOTER_LEN, "APETAGEX")) {
    const footer = end - APE_FOOTER_LEN;
    const size = u32le(bytes, footer + 12);
    const flags = u32le(bytes, footer + 20);
    const total = size + ((flags & 0x8000_0000) !== 0 ? APE_FOOTER_LEN : 0);
    return total >= APE_FOOTER_LEN && total <= len ? total : null;
  }
  const markerLen = LYRICS3_SIZE_DIGITS + LYRICS3_END.length;
  if (len >= markerLen && ascii(bytes, end - LYRICS3_END.length, LYRICS3_END)) {
    let size = 0;
    for (let i = end - markerLen; i < end - LYRICS3_END.length; i += 1) {
      const digit = bytes[i] - 0x30;
      if (digit < 0 || digit > 9) {
        return null;
      }
      size = size * 10 + digit;
    }
    const total = size + markerLen;
    return total <= len ? total : null;
  }
  if (len >= ID3V2_HEADER_LEN && ascii(bytes, end - ID3V2_HEADER_LEN, "3DI")) {
    const body = synchsafe(bytes, end - 4);
    if (body === null) {
      return null;
    }
    const total = body + 2 * ID3V2_HEADER_LEN;
    return total <= len ? total : null;
  }
  return null;
}

/**
 * Strip every MP3 tag block; returns the frame stream the relay will accept.
 * Throws an Error with a user-readable message when that is impossible.
 */
export function stripMp3Tags(body: Uint8Array): Uint8Array<ArrayBuffer> {
  let start = 0;
  for (;;) {
    const tag = leadingId3v2Len(body, start);
    if (tag === null) {
      break;
    }
    if (start + tag > body.length) {
      throw new Error("MP3: ID3 tag size exceeds the file.");
    }
    start += tag;
  }
  let end = body.length;
  for (;;) {
    const tag = trailingTagLen(body, start, end);
    if (tag === null) {
      break;
    }
    end -= tag;
  }
  const audio = body.subarray(start, end);
  if (containsId3v2Header(audio)) {
    throw new Error(
      "MP3: an ID3 tag is embedded inside the audio stream; it cannot be stripped safely.",
    );
  }
  // Walk complete frames. A frame whose declared length runs past EOF is
  // incomplete: it is dropped whole, with anything hidden inside that span.
  // Mirrors `walk_frames` in crates/buzz-media/src/mp3.rs.
  let stop = 0;
  let truncated = false;
  while (stop < audio.length) {
    const frame = frameLength(audio, stop);
    if (frame === null) {
      break;
    }
    if (frame > audio.length - stop) {
      truncated = true;
      break;
    }
    stop += frame;
  }
  if (stop === 0) {
    throw new Error("MP3: no audio frames found after removing tags.");
  }
  // Zero padding after the last frame carries nothing; any other non-frame
  // bytes are an unknown channel we refuse to guess about.
  for (let i = stop; !truncated && i < audio.length; i += 1) {
    if (audio[i] !== 0) {
      throw new Error(
        `MP3: ${audio.length - stop} unrecognized bytes after the audio frames.`,
      );
    }
  }
  return audio.slice(0, stop);
}

/**
 * Whether an upload should go through {@link stripMp3Tags}: the browser
 * called it MP3, or its bytes open with an ID3 tag or MPEG frames.
 */
export function isMp3Upload(bytes: Uint8Array, mime: string): boolean {
  if (mime === "audio/mpeg" || mime === "audio/mp3") {
    return true;
  }
  if (mime !== "" && mime !== "application/octet-stream") {
    return false;
  }
  return ascii(bytes, 0, "ID3") || looksLikeMpegAudio(bytes);
}
