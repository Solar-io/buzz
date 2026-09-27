/**
 * The bridge's Chatterbox roster (`GET /voices/chatterbox`) — parsing, the
 * reserved-voice picker policy, and the one "how is this voice shown"
 * formatter every surface shares.
 *
 * Wire shape (bridge proxy of the service's `/voices`, design §1.2):
 *   { revision, stale?, voices: [{ key: "chatterbox:<slug>", slug, label,
 *     gender, style, accent, license, sourceLabel, pocketFallback,
 *     reserved, reservedFor? }] }
 *
 * Pure and import-free (type-only imports), so `node --test` loads it.
 */

import {
  isValidChatterboxKey,
  type AgentVoiceSelection,
} from "./agentVoiceSelection.ts";

export interface ChatterboxVoice {
  key: string;
  slug: string;
  label: string;
  gender: string;
  style: string;
  reserved: boolean;
  /** Pubkey the reserved voice belongs to, when the roster names one. */
  reservedFor: string | null;
}

/** Tolerant roster parse: malformed rows are dropped, never fatal. */
export function parseChatterboxRoster(body: unknown): ChatterboxVoice[] {
  if (body === null || typeof body !== "object") {
    return [];
  }
  const voices = (body as { voices?: unknown }).voices;
  if (!Array.isArray(voices)) {
    return [];
  }
  const out: ChatterboxVoice[] = [];
  for (const raw of voices) {
    if (raw === null || typeof raw !== "object") continue;
    const v = raw as Record<string, unknown>;
    if (typeof v.key !== "string" || !isValidChatterboxKey(v.key)) continue;
    const slug = v.key.slice("chatterbox:".length);
    out.push({
      key: v.key,
      slug,
      label: typeof v.label === "string" && v.label !== "" ? v.label : slug,
      gender: typeof v.gender === "string" ? v.gender : "",
      style: typeof v.style === "string" ? v.style : "",
      reserved: v.reserved === true,
      reservedFor:
        typeof v.reservedFor === "string" ? v.reservedFor.toLowerCase() : null,
    });
  }
  return out;
}

/** Who a picker is choosing for — drives the reserved-voice policy. */
export interface VoicePickerTarget {
  pubkey: string;
  /** The agent's display name (30177 `name`). */
  name: string;
}

/**
 * RESERVED VOICES (design §3.5, Q2): a reserved voice is offered only on the
 * row of the agent it belongs to. Picker policy, not a relay rule.
 *
 * The bridge's live roster marks `evie` and `eve` reserved but carries no
 * `reservedFor` pubkey, so ownership falls back to the voice's LABEL equal
 * to the target agent's name ("Evie" ↔ the agent named Evie). When the
 * roster does name a `reservedFor` pubkey, that is authoritative instead.
 * With no target (self mode) every reserved voice is hidden; `eve` has no
 * agent of its own and is therefore never offered — mirroring its existing
 * publication ban.
 */
export function isVoiceOfferedFor(
  voice: ChatterboxVoice,
  target: VoicePickerTarget | null,
): boolean {
  if (!voice.reserved) {
    return true;
  }
  if (target === null) {
    return false;
  }
  if (voice.reservedFor !== null) {
    return voice.reservedFor === target.pubkey.toLowerCase();
  }
  return voice.label.trim().toLowerCase() === target.name.trim().toLowerCase();
}

function engineName(engine: AgentVoiceSelection["engine"]): string {
  switch (engine) {
    case "chatterbox":
      return "Chatterbox";
    case "eleven":
      return "ElevenLabs";
    case "pocket":
      return "Pocket";
    default:
      return "On-device";
  }
}

function capitalize(slug: string): string {
  return slug === "" ? slug : slug[0].toUpperCase() + slug.slice(1);
}

/**
 * `Evie (Chatterbox)` — the one display spelling of a voice. Chatterbox
 * labels come from the roster when it has the slug; otherwise the row's own
 * published label, then the capitalized slug.
 */
export function describeVoice(
  selection: AgentVoiceSelection,
  roster: readonly ChatterboxVoice[],
  publishedLabel?: string,
): string {
  if (selection.engine === "local-synth") {
    return `${publishedLabel ?? selection.voiceURI} (On-device)`;
  }
  if (selection.engine === "chatterbox") {
    const hit = roster.find((voice) => voice.key === selection.key);
    const label =
      hit?.label ??
      publishedLabel ??
      capitalize(selection.key.slice("chatterbox:".length));
    return `${label} (Chatterbox)`;
  }
  const bare = selection.key.slice(selection.key.indexOf(":") + 1);
  return `${publishedLabel ?? capitalize(bare)} (${engineName(selection.engine)})`;
}
