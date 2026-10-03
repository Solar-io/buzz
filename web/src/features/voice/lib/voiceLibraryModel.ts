import {
  HUDDLE_PREFS_PREFIX,
  loadHuddlePrefs,
} from "../../huddle/lib/huddlePrefs.ts";
import type { AgentVoiceAssignmentRow } from "./agentVoiceAssignment.ts";
import {
  isValidFishKey,
  type AgentVoiceSelection,
  type AgentVoiceSelectionRow,
} from "./agentVoiceSelection.ts";

/** Cloud engines whose picker lists are curated by the bridge. */
export type LibraryEngine = "eleven" | "fish";

export interface LibraryVoice {
  id: string;
  label: string;
  detail?: string;
}

export interface AvailableVoice extends LibraryVoice {
  inLibrary: boolean;
}

/** Normalize provider ids and supported share URLs before signing the request. */
export function parseVoiceInput(engine: LibraryEngine, raw: string): string {
  let id = raw.trim();
  if (id.includes("://")) {
    let url: URL;
    try {
      url = new URL(id);
    } catch {
      throw new Error("Enter a voice id or provider voice URL.");
    }
    if (url.protocol !== "https:" || url.username || url.password || url.port) {
      throw new Error("Use an HTTPS provider voice URL.");
    }
    if (engine === "fish" && url.hostname === "fish.audio") {
      id = /^\/m\/([A-Za-z0-9]+)\/?$/.exec(url.pathname)?.[1] ?? "";
    } else if (
      engine === "eleven" &&
      ["elevenlabs.io", "www.elevenlabs.io"].includes(url.hostname) &&
      /\/voice-library\/?$/.test(url.pathname)
    ) {
      id = url.searchParams.get("voiceId") ?? "";
    } else {
      throw new Error("Use a voice URL from the selected provider.");
    }
  }
  const valid =
    engine === "fish"
      ? isValidFishKey(`fish:${id}`)
      : /^eleven:[A-Za-z0-9]{10,36}$/.test(`eleven:${id}`);
  if (!valid)
    throw new Error(
      `Invalid ${engine === "fish" ? "Fish Audio" : "ElevenLabs"} voice id.`,
    );
  return id;
}

export interface LocalVoiceOverride {
  channelId: string;
  selection: AgentVoiceSelection;
}

/** Read this device's room overrides without changing or clearing stored preferences. */
export function localVoiceOverrides(
  store: Storage | null,
): LocalVoiceOverride[] {
  const rows: LocalVoiceOverride[] = [];
  if (!store) return rows;
  try {
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (!key?.startsWith(HUDDLE_PREFS_PREFIX)) continue;
      const channelId = key.slice(HUDDLE_PREFS_PREFIX.length);
      const voice = loadHuddlePrefs(store, channelId).voice;
      if (voice) rows.push({ channelId, selection: voice });
    }
  } catch {
    /* Blocked storage must not prevent library editing. */
  }
  return rows;
}

export interface VoiceUsage {
  source: "assignment" | "selection" | "huddle";
  pubkey?: string;
  channelId?: string;
}

/** All published layers and device-local rooms that still name this key. */
export function inUseBy(
  key: string,
  assignments: Iterable<AgentVoiceAssignmentRow>,
  selections: Iterable<AgentVoiceSelectionRow>,
  overrides: Iterable<LocalVoiceOverride>,
): VoiceUsage[] {
  const uses: VoiceUsage[] = [];
  const matches = (selection: AgentVoiceSelection) =>
    selection.engine !== "local-synth" && selection.key === key;
  for (const row of assignments)
    if (matches(row.selection))
      uses.push({ source: "assignment", pubkey: row.agentPubkey });
  for (const row of selections)
    if (matches(row.selection))
      uses.push({ source: "selection", pubkey: row.pubkey });
  for (const row of overrides)
    if (matches(row.selection))
      uses.push({ source: "huddle", channelId: row.channelId });
  return uses;
}

/** Validate untrusted bridge rows, preserving provider detail for display/search. */
export function parseLibraryVoices(body: unknown): LibraryVoice[] {
  if (
    !body ||
    typeof body !== "object" ||
    !("voices" in body) ||
    !Array.isArray(body.voices)
  )
    throw new Error("Invalid voice library response.");
  return body.voices.flatMap((row: unknown) => {
    if (
      !row ||
      typeof row !== "object" ||
      !("id" in row) ||
      !("label" in row) ||
      typeof row.id !== "string" ||
      typeof row.label !== "string"
    )
      return [];
    return [
      {
        id: row.id,
        label: row.label,
        ...("detail" in row && typeof row.detail === "string"
          ? { detail: row.detail }
          : {}),
      },
    ];
  });
}

/** Membership affects presentation only; it never gates publishing or synthesis. */
export function isOutsideLibrary(
  selection: AgentVoiceSelection | undefined,
  voices: readonly LibraryVoice[],
): boolean {
  if (
    !selection ||
    (selection.engine !== "eleven" && selection.engine !== "fish")
  )
    return false;
  return !voices.some(
    (voice) => `${selection.engine}:${voice.id}` === selection.key,
  );
}
