import type { AgentMemoryListing } from "@/features/agent-memory/lib/engrams";
import { validateAgentDefinitionText } from "./definitionText.ts";
import type { PersonaDefinition } from "./personas.ts";
import {
  FORMAT_DISCRIMINATOR,
  MAX_SNAPSHOT_JSON_BYTES,
  MAX_SNAPSHOT_PNG_BYTES,
} from "./snapshotManifest.ts";

/**
 * In-browser `buzz-agent-snapshot v1` export of a kind-30175 definition —
 * the web mirror of `agent_snapshot.rs` `build_snapshot` +
 * `commands/personas/snapshot.rs` `materialize_snapshot_bytes`, restricted to
 * what the 30175 carries. Key order follows the Rust structs' serde order and
 * `encodeSnapshotJson` matches `serde_json::to_vec_pretty` (2-space indent),
 * so a web export decodes through the desktop importer unchanged. Pure.
 */

export type MemoryLevel = "none" | "core" | "everything";

export interface SnapshotMemoryEntry {
  slug: string;
  body: string;
}

/** agent_snapshot.rs MAX_AVATAR_INLINE_BYTES. */
const MAX_AVATAR_INLINE_BYTES = 2 * 1024 * 1024;
/** DEFAULT_AGENT_PARALLELISM — into_agent_record fills it when unset. */
const DEFAULT_PARALLELISM = 10;

export const BLANK_QUAD_NOTE =
  "Desktop fills blank model/provider/harness from its global defaults on export; the web leaves them blank. The importer applies its own defaults.";

function contentObject(persona: PersonaDefinition): Record<string, unknown> {
  try {
    const parsed = JSON.parse(persona.event.content) as unknown;
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function str(content: Record<string, unknown>, key: string): string {
  return typeof content[key] === "string" ? (content[key] as string) : "";
}

function strList(content: Record<string, unknown>, key: string): string[] {
  const value = content[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/** Magic-byte mime sniff (resolve_avatar), png by default. */
export function sniffImageMime(bytes: Uint8Array): string {
  const starts = (sig: number[], at = 0) =>
    sig.every((b, i) => bytes[at + i] === b);
  if (starts([0x89, 0x50, 0x4e, 0x47])) {
    return "image/png";
  }
  if (starts([0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }
  if (starts([0x47, 0x49, 0x46, 0x38])) {
    return "image/gif";
  }
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) {
    return "image/webp";
  }
  return "image/png";
}

/** Decode a base64 `data:` URL's bytes, or null (decode_avatar_data_url). */
export function decodeDataUrl(url: string): Uint8Array | null {
  const match = /^data:[^,;]*(?:;[^,;]*)*;base64,(.*)$/s.exec(url.trim());
  if (!match) {
    return null;
  }
  try {
    const binary = atob(match[1]);
    return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * Flatten a decrypted listing into manifest entries: core only for "core";
 * core + every mem/* (already sorted by slug) for "everything". Refuses a
 * truncated or partially undecryptable listing — never a silently partial
 * export.
 */
export function memoryEntriesFromListing(
  listing: AgentMemoryListing,
  level: MemoryLevel,
): SnapshotMemoryEntry[] | { error: string } {
  if (level === "none") {
    return [];
  }
  if (listing.truncated) {
    return { error: "Memory may be incomplete — export in the desktop app." };
  }
  if (listing.undecryptable > 0) {
    return {
      error: `${listing.undecryptable} memory entries could not be decrypted.`,
    };
  }
  const entries: SnapshotMemoryEntry[] = [];
  if (listing.core) {
    entries.push({ slug: listing.core.slug, body: listing.core.body });
  }
  if (level === "everything") {
    for (const mem of listing.memories) {
      entries.push({ slug: mem.slug, body: mem.body });
    }
  }
  return entries;
}

/**
 * Build the manifest object for a definition. Returns notes the dialog shows
 * (e.g. the blank-quad caveat). `encodedSize` is checked by the encoders.
 */
export function buildDefinitionSnapshot(
  persona: PersonaDefinition,
  memory: { level: MemoryLevel; entries: SnapshotMemoryEntry[] },
): { snapshot: Record<string, unknown>; notes: string[] } | { error: string } {
  const content = contentObject(persona);
  const displayName = str(content, "display_name");
  if (displayName.trim() === "") {
    return { error: "Snapshot definition.name is empty" };
  }
  const systemPrompt = str(content, "system_prompt");
  const validation = validateAgentDefinitionText(displayName, systemPrompt);
  if (!validation.ok) {
    return { error: validation.error };
  }
  if (memory.level === "none" && memory.entries.length > 0) {
    return {
      error:
        "Cannot write a snapshot with memory.level 'none' and non-empty memory entries.",
    };
  }

  const notes: string[] = [];
  // Hardcoded AgentSnapshotDefinition serde order.
  const definition: Record<string, unknown> = {
    name: displayName,
    sourceIsBuiltin: false,
  };
  if (systemPrompt !== "") {
    definition.systemPrompt = systemPrompt;
  }
  let blank = false;
  for (const key of ["runtime", "model", "provider"] as const) {
    const value = str(content, key);
    if (value.trim() !== "") {
      definition[key] = value;
    } else {
      blank = true;
    }
  }
  if (blank) {
    notes.push(BLANK_QUAD_NOTE);
  }
  definition.parallelism =
    typeof content.parallelism === "number"
      ? content.parallelism
      : DEFAULT_PARALLELISM;
  const respondTo = str(content, "respond_to");
  if (respondTo !== "") {
    definition.respondTo = respondTo;
  }
  const allowlist = strList(content, "respond_to_allowlist");
  if (allowlist.length > 0) {
    definition.respondToAllowlist = allowlist;
  }
  const namePool = strList(content, "name_pool");
  if (namePool.length > 0) {
    definition.namePool = namePool;
  }

  // AgentSnapshotProfile: displayName, (about never), avatarDataUrl | avatarUrl.
  const profile: Record<string, unknown> = { displayName };
  const avatarUrl = str(content, "avatar_url");
  const inline = avatarUrl ? decodeDataUrl(avatarUrl) : null;
  if (inline && inline.length <= MAX_AVATAR_INLINE_BYTES) {
    profile.avatarDataUrl = `data:${sniffImageMime(inline)};base64,${bytesToBase64(inline)}`;
  } else if (avatarUrl !== "") {
    profile.avatarUrl = avatarUrl;
  }

  const memorySection: Record<string, unknown> = { level: memory.level };
  if (memory.entries.length > 0) {
    memorySection.entries = memory.entries.map((entry) => ({
      slug: entry.slug,
      body: entry.body,
    }));
  }

  return {
    snapshot: {
      format: FORMAT_DISCRIMINATOR,
      version: 1,
      definition,
      profile,
      memory: memorySection,
    },
    notes,
  };
}

/** serde_json::to_vec_pretty equivalent. */
export function encodeSnapshotJson(snapshot: object): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(snapshot, null, 2));
}

/** validate_snapshot_encode_size, Rust wording. */
export function validateEncodeSize(
  bytesLength: number,
  isPng: boolean,
): string | null {
  if (isPng && bytesLength > MAX_SNAPSHOT_PNG_BYTES) {
    return "Snapshot exceeds the 10 MiB size limit for .agent.png files. Reduce the avatar image size or use JSON format.";
  }
  if (!isPng && bytesLength > MAX_SNAPSHOT_JSON_BYTES) {
    return "Snapshot exceeds the 5 MiB size limit for .agent.json files. Reduce memory size or use a config-only snapshot.";
  }
  return null;
}

/** util::slugify(name, "agent", 50) + the snapshot extension. */
export function snapshotFilename(displayName: string, png: boolean): string {
  // Per code point, like Rust's chars(): one hyphen per non-ASCII char.
  let raw = Array.from(displayName.toLowerCase(), (ch) =>
    /^[a-z0-9]$/.test(ch) ? ch : "-",
  )
    .join("")
    .replace(/^-+|-+$/g, "");
  if (raw === "") {
    raw = "agent";
  }
  if (raw.length > 50) {
    raw = raw.slice(0, 50);
  }
  raw = raw.replace(/-+$/, "");
  return `${raw}${png ? ".agent.png" : ".agent.json"}`;
}
