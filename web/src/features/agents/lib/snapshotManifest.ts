import { validateAgentDefinitionText } from "./definitionText.ts";

/**
 * Web decoder for `buzz-agent-snapshot v1` payloads — the read-side mirror of
 * the desktop's decode path (`agent_snapshot.rs` decode/validate +
 * `agent_snapshot_envelope.rs` dispatch + the size caps of
 * `commands/personas/snapshot/import.rs` and the verified fetch of
 * `commands/media_download.rs`). Pure: no React, no relay imports, injectable
 * fetch — the node runner loads this file directly.
 *
 * SECURITY SHAPE (Phase 3 §6.1): a snapshot manifest is attacker-controllable
 * text. Decoding is gated behind the byte caps below and, on the preview
 * path, the caller's sha256-verified fetch; the decoded definition then runs
 * the rule-12 rejection (`definitionText.ts`) BEFORE anything renders or
 * installs. Nothing is silently stripped; a violating manifest is refused
 * with the Rust wording.
 *
 * Locked cards (`buzz-agent-snapshot-encrypted`) are structurally validated
 * and refused — no decrypt on the web (v1 cut line, plan §3.3). Team
 * snapshots (`buzz-team-snapshot`) decode to a `team` marker: their members
 * each need full rule-12 review, which only the desktop importer provides.
 * Unknown or missing format discriminators are ERRORS, never fall-throughs
 * (envelope.rs dispatch discipline).
 */

// ── Caps and discriminators (mirrored constants) ─────────────────────────────

/** import.rs MAX_SNAPSHOT_JSON_BYTES. */
export const MAX_SNAPSHOT_JSON_BYTES = 5 * 1024 * 1024;
/** import.rs MAX_SNAPSHOT_PNG_BYTES. */
export const MAX_SNAPSHOT_PNG_BYTES = 10 * 1024 * 1024;
/** media_download.rs team caps (transit validation only on the web). */
export const MAX_TEAM_SNAPSHOT_JSON_BYTES = 25 * 1024 * 1024;
export const MAX_TEAM_SNAPSHOT_PNG_BYTES = 50 * 1024 * 1024;

/** agent_snapshot.rs FORMAT_DISCRIMINATOR. */
export const FORMAT_DISCRIMINATOR = "buzz-agent-snapshot";
/** agent_snapshot_envelope.rs LOCKED_FORMAT. */
export const LOCKED_FORMAT = "buzz-agent-snapshot-encrypted";
/** team_snapshot.rs FORMAT_DISCRIMINATOR. */
export const TEAM_FORMAT = "buzz-team-snapshot";
/** agent_snapshot.rs PNG_CHUNK_KEYWORD. */
export const PNG_CHUNK_KEYWORD = "buzz_agent_snapshot";
/** agent_snapshot_envelope.rs LOCKED_CARD_REFUSAL, verbatim. */
export const LOCKED_CARD_REFUSAL =
  "This card is locked to its owner and agent. Only they can import it.";
/** envelope.rs MAX_LOCKED_CIPHERTEXT_BYTES (base64 chars) + envelope headroom. */
const MAX_LOCKED_CIPHERTEXT_CHARS = 90_000;
const MAX_LOCKED_ENVELOPE_JSON_BYTES = MAX_LOCKED_CIPHERTEXT_CHARS + 1024;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const LOCKED_SCHEME = "nip44-v2";

// ── Decoded views ────────────────────────────────────────────────────────────

export interface AgentSnapshotDefinitionView {
  name: string;
  sourceIsBuiltin: boolean;
  systemPrompt: string | null;
  runtime: string | null;
  model: string | null;
  provider: string | null;
  parallelism: number | null;
  /** Wire string as exported ("owner-only" | "anyone" | "allowlist"). */
  respondTo: string | null;
  respondToAllowlist: string[];
  namePool: string[];
  idleTimeoutSeconds: number | null;
  maxTurnDurationSeconds: number | null;
}

export interface AgentSnapshotView {
  definition: AgentSnapshotDefinitionView;
  /** profile.displayName — the reviewed display name. */
  displayName: string;
  about: string | null;
  /** Inline avatar bytes as a data URL, when the manifest carries them. */
  avatarDataUrl: string | null;
  /** Hosted avatar URL fallback. */
  avatarUrl: string | null;
  /** Wire memory level ("none" | "core" | "everything"). */
  memoryLevel: string;
  memoryEntryCount: number;
  /** Pretty-printed manifest exactly as decoded (re-serialized verbatim). */
  manifestJson: string;
}

export type SnapshotDecode =
  | { kind: "agent"; snapshot: AgentSnapshotView }
  | { kind: "locked"; refusal: string }
  | { kind: "team" }
  | { kind: "error"; error: string };

// ── Decode entry point ───────────────────────────────────────────────────────

/**
 * Decode raw snapshot bytes (.agent.json or .agent.png). Sniffs by magic
 * bytes, never by extension. Never throws — every failure is
 * `{ kind: "error", error }` with the Rust wording where one exists.
 */
export function decodeSnapshotBytes(bytes: Uint8Array): SnapshotDecode {
  if (hasPngMagic(bytes)) {
    if (bytes.length > MAX_SNAPSHOT_PNG_BYTES) {
      return {
        kind: "error",
        error: `Snapshot file is too large (${mib(bytes)} MiB). PNG snapshots must be under 10 MiB.`,
      };
    }
    const payload = extractChunkPayloadPng(bytes);
    if ("error" in payload) {
      return { kind: "error", error: payload.error };
    }
    return dispatchChunkPayload(payload.json);
  }
  if (bytes.length > MAX_SNAPSHOT_JSON_BYTES) {
    return {
      kind: "error",
      error: `Snapshot file is too large (${mib(bytes)} MiB). JSON snapshots must be under 5 MiB.`,
    };
  }
  const text = decodeUtf8(bytes);
  if (text === null) {
    return { kind: "error", error: "Invalid snapshot JSON: not UTF-8." };
  }
  return dispatchChunkPayload(text);
}

function mib(bytes: Uint8Array): number {
  return Math.floor(bytes.length / (1024 * 1024));
}

function hasPngMagic(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && PNG_MAGIC.every((b, i) => bytes[i] === b);
}

// ── Format dispatch (envelope.rs parse_chunk_payload mirror) ─────────────────

function dispatchChunkPayload(jsonText: string): SnapshotDecode {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    return {
      kind: "error",
      error: `Invalid snapshot JSON: ${error instanceof Error ? error.message : "parse failed"}`,
    };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "error", error: "Invalid snapshot JSON: not an object." };
  }
  const format = (parsed as Record<string, unknown>).format;
  if (format === FORMAT_DISCRIMINATOR) {
    return decodePlainManifest(parsed as Record<string, unknown>);
  }
  if (format === LOCKED_FORMAT) {
    return decodeLockedEnvelope(parsed as Record<string, unknown>, jsonText);
  }
  if (format === TEAM_FORMAT) {
    // Team members each need full rule-12 review — a desktop-only surface.
    // The card still renders and downloads; the preview says where to go.
    return { kind: "team" };
  }
  if (typeof format === "string") {
    return {
      kind: "error",
      // Rust {:?} — quoted debug form.
      error: `Unsupported snapshot format: ${JSON.stringify(format)}`,
    };
  }
  return {
    kind: "error",
    error: "Snapshot payload has no format discriminator.",
  };
}

// ── Plain manifest (agent_snapshot.rs validate_snapshot mirror) ──────────────

function decodePlainManifest(parsed: Record<string, unknown>): SnapshotDecode {
  const definition = parsed.definition;
  const profile = parsed.profile;
  const memory = parsed.memory;
  if (!isObject(definition) || !isObject(profile) || !isObject(memory)) {
    return {
      kind: "error",
      error: "Invalid snapshot JSON: missing definition, profile, or memory.",
    };
  }
  if (parsed.version !== 1) {
    return {
      kind: "error",
      error: `Unsupported snapshot version: ${String(parsed.version)} (expected 1)`,
    };
  }
  const name = stringOr(definition.name, "");
  const displayName = stringOr(profile.displayName, "");
  if (name.replace(/^\s+|\s+$/g, "") === "") {
    return { kind: "error", error: "Snapshot definition.name is empty" };
  }
  if (displayName.replace(/^\s+|\s+$/g, "") === "") {
    return {
      kind: "error",
      error: "Snapshot profile.displayName is empty",
    };
  }
  const systemPrompt = optString(definition.systemPrompt);
  const rule12 = validateAgentDefinitionText(displayName, systemPrompt ?? "");
  if (!rule12.ok) {
    return {
      kind: "error",
      error: `Snapshot definition is unsafe: ${rule12.error}`,
    };
  }

  const entries = Array.isArray(memory.entries) ? memory.entries : [];
  const memoryLevel = stringOr(memory.level, "");
  if (memoryLevel === "none" && entries.length > 0) {
    return {
      kind: "error",
      error:
        "Snapshot is malformed: memory.level is 'none' but entries are present.",
    };
  }

  const allowlist = Array.isArray(definition.respondToAllowlist)
    ? definition.respondToAllowlist.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : [];
  const namePool = Array.isArray(definition.namePool)
    ? definition.namePool.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : [];

  return {
    kind: "agent",
    snapshot: {
      definition: {
        name,
        sourceIsBuiltin: definition.sourceIsBuiltin === true,
        systemPrompt,
        runtime: optString(definition.runtime),
        model: optString(definition.model),
        provider: optString(definition.provider),
        parallelism: optNumber(definition.parallelism),
        respondTo: optString(definition.respondTo),
        respondToAllowlist: allowlist,
        namePool,
        idleTimeoutSeconds: optNumber(definition.idleTimeoutSeconds),
        maxTurnDurationSeconds: optNumber(definition.maxTurnDurationSeconds),
      },
      displayName,
      about: optString(profile.about),
      avatarDataUrl: optString(profile.avatarDataUrl),
      avatarUrl: optString(profile.avatarUrl),
      memoryLevel,
      memoryEntryCount: entries.length,
      // The desktop preview re-serializes its typed struct; we re-stringify
      // the parsed object — same data, source key order, pretty-printed.
      manifestJson: JSON.stringify(parsed, null, 2),
    },
  };
}

// ── Locked envelope (envelope.rs validate_envelope mirror) ───────────────────

function decodeLockedEnvelope(
  parsed: Record<string, unknown>,
  jsonText: string,
): SnapshotDecode {
  // Cap before any structural work (envelope.rs rejects oversized JSON first).
  if (jsonText.length > MAX_LOCKED_ENVELOPE_JSON_BYTES) {
    return {
      kind: "error",
      error: "Locked card envelope exceeds the maximum size.",
    };
  }
  const encryption = parsed.encryption;
  if (!isObject(encryption)) {
    return {
      kind: "error",
      error: "Invalid locked card envelope: missing encryption.",
    };
  }
  if (parsed.version !== 1) {
    return {
      kind: "error",
      error: `Unsupported locked card envelope version: ${String(parsed.version)} (expected 1)`,
    };
  }
  if (encryption.scheme !== LOCKED_SCHEME) {
    return {
      kind: "error",
      error: `Unsupported locked card encryption scheme: ${JSON.stringify(
        String(encryption.scheme ?? ""),
      )} (expected ${JSON.stringify(LOCKED_SCHEME)})`,
    };
  }
  const owner = stringOr(encryption.ownerPubkey, "");
  const agent = stringOr(encryption.agentPubkey, "");
  if (!isCanonicalPubkey(owner) || !isCanonicalPubkey(agent)) {
    return {
      kind: "error",
      error:
        "Locked card envelope has a malformed ownerPubkey or agentPubkey (expected 64 lowercase hex chars).",
    };
  }
  if (owner === agent) {
    return {
      kind: "error",
      error: "Locked card envelope owner and agent pubkeys must differ.",
    };
  }
  const ciphertext = stringOr(encryption.ciphertext, "");
  if (ciphertext.length > MAX_LOCKED_CIPHERTEXT_CHARS) {
    return {
      kind: "error",
      error: "Locked card ciphertext exceeds the maximum size.",
    };
  }
  if (ciphertext === "") {
    return { kind: "error", error: "Locked card ciphertext is empty." };
  }
  // Structural pass only. No decrypt on the web (v1); the refusal is the
  // only thing a non-endpoint viewer may learn.
  return { kind: "locked", refusal: LOCKED_CARD_REFUSAL };
}

/** envelope.rs parse_canonical_pubkey: 64 lowercase hex chars. */
function isCanonicalPubkey(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

// ── PNG chunk walker (extract_chunk_payload_png mirror) ──────────────────────

type ChunkPayloadResult = { json: string } | { error: string };

/**
 * Walk PNG chunks and return the base64-DECODED `buzz_agent_snapshot` tEXt
 * payload as JSON text. Chunk lengths are validated against the buffer at
 * every step. CRC is deliberately NOT verified: the caller's sha256 check is
 * the integrity gate (a CRC pass would prove nothing sha256 does not, and
 * the Rust png crate's CRC check buys nothing once the bytes are
 * hash-verified end to end). Text chunks are only meaningful before IDAT,
 * so scanning stops there — the png crate's read_info scope.
 */
function extractChunkPayloadPng(bytes: Uint8Array): ChunkPayloadResult {
  if (bytes.length < 8 || !PNG_SIGNATURE.every((b, i) => bytes[i] === b)) {
    return { error: "Invalid PNG: bad signature." };
  }
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const dataLength = view.getUint32(offset);
    const type = latin1Slice(bytes, offset + 4, offset + 8);
    const chunkEnd = offset + 8 + dataLength + 4; // + CRC
    if (chunkEnd > bytes.length) {
      return {
        error: "Invalid PNG: chunk length exceeds the remaining buffer.",
      };
    }
    if (type === "tEXt") {
      const dataStart = offset + 8;
      const dataEnd = dataStart + dataLength;
      const separator = bytes.indexOf(0, dataStart);
      if (separator !== -1 && separator < dataEnd) {
        const keyword = latin1Slice(bytes, dataStart, separator);
        if (keyword === PNG_CHUNK_KEYWORD) {
          const text = latin1Slice(bytes, separator + 1, dataEnd).trim();
          const decoded = base64ToBytes(text);
          if (decoded === null) {
            return { error: "Invalid base64 in PNG chunk." };
          }
          const json = decodeUtf8(decoded);
          if (json === null) {
            return { error: "Invalid snapshot JSON: not UTF-8." };
          }
          return { json };
        }
      }
    }
    if (type === "IDAT" || type === "IEND") {
      break;
    }
    offset = chunkEnd;
  }
  return {
    error: "PNG does not contain a buzz_agent_snapshot tEXt chunk",
  };
}

function latin1Slice(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let i = start; i < end; i++) {
    out += String.fromCharCode(bytes[i]);
  }
  return out;
}

function base64ToBytes(text: string): Uint8Array | null {
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

// ── Tolerant field readers ───────────────────────────────────────────────────

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function optString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function optNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// ── sha256 + verified fetch (media_download.rs fetch_snapshot_bytes mirror) ──

/** Lowercase hex SHA-256 over the default WebCrypto subtle. */
export async function sha256Hex(
  bytes: Uint8Array,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<string> {
  const digest = await subtle.digest(
    "SHA-256",
    // TS 5.7+ types a generic Uint8Array's buffer as ArrayBufferLike while
    // digest wants an ArrayBuffer-backed view; every producer here is one,
    // and digest only reads the bytes.
    bytes as unknown as BufferSource,
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

type SnapshotFileKind = "agent-json" | "agent-png" | "team-json" | "team-png";

function snapshotKindForFilename(
  filename: string,
): { kind: SnapshotFileKind } | { error: string } {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".agent.json")) {
    return { kind: "agent-json" };
  }
  if (lower.endsWith(".agent.png")) {
    return { kind: "agent-png" };
  }
  if (lower.endsWith(".team.json")) {
    return { kind: "team-json" };
  }
  if (lower.endsWith(".team.png")) {
    return { kind: "team-png" };
  }
  return {
    error: `"${filename}" is not a snapshot filename — expected .agent.json, .agent.png, .team.json, or .team.png`,
  };
}

function kindCap(kind: SnapshotFileKind): number {
  switch (kind) {
    case "agent-json":
      return MAX_SNAPSHOT_JSON_BYTES;
    case "agent-png":
      return MAX_SNAPSHOT_PNG_BYTES;
    case "team-json":
      return MAX_TEAM_SNAPSHOT_JSON_BYTES;
    case "team-png":
      return MAX_TEAM_SNAPSHOT_PNG_BYTES;
  }
}

function kindLabel(kind: SnapshotFileKind): string {
  switch (kind) {
    case "agent-json":
      return ".agent.json";
    case "agent-png":
      return ".agent.png";
    case "team-json":
      return ".team.json";
    case "team-png":
      return ".team.png";
  }
}

export interface SnapshotFetchDeps {
  /** Signed GET returning the raw bytes (blossom auth; injected for tests). */
  signedFetch: (url: string) => Promise<Uint8Array>;
  /** Injectable hash (defaults to sha256Hex over globalThis.crypto). */
  sha256?: (bytes: Uint8Array) => Promise<string>;
}

/**
 * Bounded, verified in-memory fetch of a snapshot attachment — the web
 * counterpart of the desktop's `fetch_snapshot_bytes` command. Validates the
 * declared metadata BEFORE the network call, then checks size, sha256, and
 * PNG/JSON magic against the filename-selected kind. Throws Error with the
 * Rust wording on every failure; resolves with the verified bytes.
 */
export async function fetchSnapshotBytesWeb(
  url: string,
  expected: { filename: string; sha256: string; size?: number },
  deps: SnapshotFetchDeps,
): Promise<Uint8Array> {
  const kindResult = snapshotKindForFilename(expected.filename);
  if ("error" in kindResult) {
    throw new Error(kindResult.error);
  }
  const kind = kindResult.kind;

  if (expected.sha256 === "") {
    throw new Error("missing expected sha256 (imeta x field)");
  }
  if (expected.sha256.length !== 64 || !/^[0-9a-f]+$/.test(expected.sha256)) {
    throw new Error(
      "invalid expected sha256 — must be a 64-hex-digit lowercase string",
    );
  }
  const declaredSize = expected.size ?? 0;
  if (declaredSize > kindCap(kind)) {
    throw new Error(
      `declared size ${declaredSize} exceeds the ${kindCap(kind) / (1024 * 1024)} MiB cap for this format`,
    );
  }

  const bytes = await deps.signedFetch(url);

  if (bytes.length > kindCap(kind)) {
    throw new Error(
      `Snapshot file is too large (${Math.floor(bytes.length / (1024 * 1024))} MiB). ${kindLabel(kind)} snapshots must be under ${kindCap(kind) / (1024 * 1024)} MiB.`,
    );
  }
  if (declaredSize !== 0 && bytes.length !== declaredSize) {
    throw new Error(
      `size mismatch: fetched ${bytes.length} bytes but imeta declared ${declaredSize}`,
    );
  }
  const hasher = deps.sha256 ?? sha256Hex;
  const actual = await hasher(bytes);
  if (actual !== expected.sha256.toLowerCase()) {
    throw new Error(
      "hash mismatch: fetched bytes do not match the declared SHA-256",
    );
  }
  const magicIsPng = hasPngMagic(bytes);
  const kindIsPng = kind === "agent-png" || kind === "team-png";
  if (kindIsPng && !magicIsPng) {
    throw new Error(
      `format mismatch: filename is ${kindLabel(kind)} but bytes are not a PNG`,
    );
  }
  if (!kindIsPng && magicIsPng) {
    throw new Error(
      `format mismatch: filename is ${kindLabel(kind)} but bytes are a PNG`,
    );
  }
  return bytes;
}
