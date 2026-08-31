/**
 * Huddle audio wire protocol (relay crates/buzz-relay/src/audio/{wire,room}.rs):
 *
 * Uplink binary frame: 8-byte header + Opus packet.
 *   byte 0..=1 : seq        u16  (BE) — sender-authored, wraps
 *   byte 2..=5 : ts_48k     u32  (BE) — 48 kHz RTP-style media timestamp
 *   byte 6     : level_dbov i8         — [-127, 0]; telemetry only
 *   byte 7     : flags      u8         — bit 0 = DTX
 *
 * Downlink binary frame (v3): [peer_index u8, epoch u8] + the uplink shape.
 * (v2 rooms prefix one byte; v3 rooms are what this client negotiates.)
 *
 * Control text frames: challenge → auth → joined / left / error.
 */

export const V2_HEADER_LEN = 8;
export const FLAG_DTX = 0x01;

/** Build the uplink header for an Opus packet. */
export function buildFrameHeader(
  seq: number,
  ts48k: number,
  levelDbov: number,
  flags = 0,
): Uint8Array<ArrayBuffer> {
  const header = new Uint8Array(V2_HEADER_LEN);
  const view = new DataView(header.buffer);
  view.setUint16(0, seq & 0xffff);
  view.setUint32(2, ts48k >>> 0);
  const clamped = Math.max(-127, Math.min(0, Math.round(levelDbov)));
  view.setInt8(6, clamped);
  view.setUint8(7, flags & 0xff);
  return header;
}

/** Assemble a full uplink frame: header + Opus payload. */
export function buildUplinkFrame(
  seq: number,
  ts48k: number,
  levelDbov: number,
  opus: Uint8Array,
  flags = 0,
): Uint8Array<ArrayBuffer> {
  const header = buildFrameHeader(seq, ts48k, levelDbov, flags);
  const frame = new Uint8Array(header.length + opus.length);
  frame.set(header, 0);
  frame.set(opus, header.length);
  return frame;
}

export interface DownlinkFrame {
  peerIndex: number;
  epoch: number;
  seq: number;
  ts48k: number;
  levelDbov: number;
  dtx: boolean;
  opus: Uint8Array;
}

/**
 * Parse a v3 downlink frame. Returns null for anything shorter than the
 * prefix + header. DTX frames keep their payload (comfort noise) but carry
 * the flag for the decoder's skip path.
 */
export function parseDownlinkFrame(data: ArrayBuffer): DownlinkFrame | null {
  if (data.byteLength < 2 + V2_HEADER_LEN) {
    return null;
  }
  const bytes = new Uint8Array(data);
  const peerIndex = bytes[0];
  const epoch = bytes[1];
  const view = new DataView(data, 2, V2_HEADER_LEN);
  const seq = view.getUint16(0);
  const ts48k = view.getUint32(2);
  const levelDbov = view.getInt8(6);
  const flags = view.getUint8(7);
  return {
    peerIndex,
    epoch,
    seq,
    ts48k,
    levelDbov,
    dtx: (flags & FLAG_DTX) !== 0,
    opus: bytes.subarray(2 + V2_HEADER_LEN),
  };
}

/** Map an AnalyserNode RMS (0..1) to dBov telemetry. */
export function rmsToDbov(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 0) {
    return -127;
  }
  const db = 20 * Math.log10(rms);
  return Math.max(-127, Math.min(0, db));
}
