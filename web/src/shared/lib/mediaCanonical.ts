/**
 * Client-side media canonicalization — a port of the relay's own rules
 * (crates/buzz-media/src/validation.rs). The relay rejects any JPEG APPn/COM
 * segment outside canonical JFIF/Adobe and any non-rendering ancillary PNG
 * chunk, and browser encoders are not guaranteed to omit them. Dropping the
 * forbidden segments client-side makes uploads pass on the first try.
 *
 * Returns null when the bytes cannot be parsed confidently — the caller then
 * uploads as-is and lets the relay render the verdict.
 */

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** PNG ancillary chunks the relay allows (validation.rs known_rendering). */
const PNG_RENDERING_CHUNKS = new Set([
  "cHRM",
  "gAMA",
  "sBIT",
  "sRGB",
  "bKGD",
  "hIST",
  "tRNS",
  "sPLT",
  "acTL",
  "fcTL",
  "fdAT",
]);

export function canonicalizeImage(
  bytes: Uint8Array,
  mime: string,
): Uint8Array | null {
  if (mime === "image/jpeg") {
    return canonicalizeJpeg(bytes);
  }
  if (mime === "image/png") {
    return canonicalizePng(bytes);
  }
  return null;
}

/**
 * JPEG: keep SOI, quantization/table/frame/scan structure, canonical APP0
 * JFIF, Adobe APP14; drop APP1-APPD, APPF, COM, and non-canonical APP0.
 */
function canonicalizeJpeg(bytes: Uint8Array): Uint8Array | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null;
  }
  const out: number[] = [0xff, 0xd8];
  let i = 2;
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) {
      return null;
    }
    const fillStart = i;
    while (i < bytes.length && bytes[i] === 0xff) {
      i += 1;
    }
    if (i >= bytes.length) {
      return null;
    }
    const marker = bytes[i];
    i += 1;
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      for (let j = fillStart; j < i; j++) {
        out.push(bytes[j]);
      }
      continue;
    }
    if (marker === 0xd9) {
      if (i !== bytes.length) {
        return null;
      }
      out.push(0xff, 0xd9);
      return Uint8Array.from(out);
    }
    if (marker === 0xd8 || marker === 0x00) {
      return null;
    }
    if (i + 2 > bytes.length) {
      return null;
    }
    const len = (bytes[i] << 8) | bytes[i + 1];
    if (len < 2) {
      return null;
    }
    const end = i + len;
    if (end > bytes.length) {
      return null;
    }
    const payload = bytes.subarray(i + 2, end);
    let keep = true;
    if (marker === 0xe0) {
      keep =
        payload.length >= 14 &&
        ascii(payload, 0, 5) === "JFIF\x00" &&
        payload.length === 14 + 3 * payload[12] * payload[13];
    } else if (marker === 0xee) {
      keep = payload.length === 12 && ascii(payload, 0, 5) === "Adobe";
    } else if (
      (marker >= 0xe1 && marker <= 0xed) ||
      marker === 0xef ||
      marker === 0xfe
    ) {
      keep = false;
    }
    if (keep) {
      for (let j = fillStart; j < end; j++) {
        out.push(bytes[j]);
      }
    }
    i = end;
    // Scan data runs until a non-stuffed marker; copied verbatim next loop.
    if (marker === 0xda) {
      while (i < bytes.length) {
        if (
          bytes[i] === 0xff &&
          i + 1 < bytes.length &&
          bytes[i + 1] !== 0x00 &&
          !(bytes[i + 1] >= 0xd0 && bytes[i + 1] <= 0xd7)
        ) {
          break;
        }
        out.push(bytes[i]);
        i += 1;
      }
    }
  }
  return null;
}

/** PNG: drop ancillary chunks outside the rendering allowlist. */
function canonicalizePng(bytes: Uint8Array): Uint8Array | null {
  for (let s = 0; s < PNG_SIG.length; s++) {
    if (bytes[s] !== PNG_SIG[s]) {
      return null;
    }
  }
  const out: number[] = [...PNG_SIG];
  let i = PNG_SIG.length;
  let sawIend = false;
  while (i + 12 <= bytes.length) {
    const len =
      ((bytes[i] << 24) |
        (bytes[i + 1] << 16) |
        (bytes[i + 2] << 8) |
        bytes[i + 3]) >>>
      0;
    const kind = String.fromCharCode(
      bytes[i + 4],
      bytes[i + 5],
      bytes[i + 6],
      bytes[i + 7],
    );
    const end = i + 12 + len;
    if (end > bytes.length) {
      return null;
    }
    const ancillary = (bytes[i + 4] & 0x20) !== 0;
    const keep =
      !ancillary ||
      PNG_RENDERING_CHUNKS.has(kind) ||
      (kind === "tEXt" && isSnapshotTextChunk(bytes.subarray(i + 8, end - 4)));
    if (keep) {
      for (let j = i; j < end; j++) {
        out.push(bytes[j]);
      }
    }
    i = end;
    if (kind === "IEND") {
      sawIend = true;
      break;
    }
  }
  if (!sawIend || i !== bytes.length) {
    return null;
  }
  return Uint8Array.from(out);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let i = start; i < end; i++) {
    out += String.fromCharCode(bytes[i]);
  }
  return out;
}

function isSnapshotTextChunk(payload: Uint8Array): boolean {
  for (const keyword of ["buzz_agent_snapshot", "buzz_team_snapshot"]) {
    if (
      payload.length > keyword.length &&
      ascii(payload, 0, keyword.length) === keyword &&
      payload[keyword.length] === 0
    ) {
      return true;
    }
  }
  return false;
}
