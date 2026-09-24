import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import { validateAgentDefinitionText } from "./definitionText.ts";
import type { RosterRow } from "./roster.ts";

/**
 * Web-side kind-30175 definition edit: republish the owner's latest
 * definition with the edited quad, preserving every other content key and
 * every tag byte-for-byte so desktop's `persona_from_event` +
 * `reconcile_inbound_persona_event` accept it like its own edit. Pure,
 * React-free for the node runner.
 */

export interface DefinitionEdits {
  displayName: string;
  systemPrompt: string;
  model: string;
  provider: string;
}

export interface PersonaUpdateTemplate {
  kind: 30175;
  tags: string[][];
  content: string;
  created_at: number;
}

/** Whether the web may edit this row's definition, with a reason when not. */
export function definitionEditable(
  row: Pick<RosterRow, "entry" | "persona">,
): { ok: true } | { ok: false; reason: string } {
  const personaId = row.entry.personaId;
  if (personaId === null) {
    return { ok: false, reason: "This agent isn't linked to a definition." };
  }
  if (personaId.startsWith("builtin:")) {
    return { ok: false, reason: "Built-in definitions can't be edited." };
  }
  if (row.persona === null) {
    return {
      ok: false,
      reason: "Definition not found on the relay — edit it in the desktop app.",
    };
  }
  return { ok: true };
}

/** Every roster row linked to the given definition id. */
export function agentsSharingDefinition<T extends Pick<RosterRow, "entry">>(
  roster: readonly T[],
  personaId: string,
): T[] {
  return roster.filter((row) => row.entry.personaId === personaId);
}

function currentString(parsed: Record<string, unknown>, key: string): string {
  const value = parsed[key];
  return typeof value === "string" ? value : "";
}

/**
 * Build the replacement 30175 template. Keys are written only when their
 * value changes, so untouched keys (including unknown future ones) keep
 * their value and position. Blank model/provider deletes the key (desktop's
 * `None`); display_name and system_prompt are always strings.
 */
export function buildPersonaUpdate(
  latest: Pick<SignedNostrEvent, "content" | "tags" | "created_at">,
  edits: DefinitionEdits,
  nowSecs: number,
): { template: PersonaUpdateTemplate } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(latest.content);
  } catch {
    return { error: "The current definition is not valid JSON." };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "The current definition is not a JSON object." };
  }
  const content = parsed as Record<string, unknown>;
  let changed = false;

  const setString = (key: string, value: string, deleteWhenBlank: boolean) => {
    if (value === currentString(content, key)) {
      return;
    }
    changed = true;
    if (deleteWhenBlank && value === "") {
      delete content[key];
    } else {
      content[key] = value;
    }
  };

  setString("display_name", edits.displayName.trim(), false);
  setString("system_prompt", edits.systemPrompt.trim(), false);
  setString("model", edits.model.trim(), true);
  setString("provider", edits.provider.trim(), true);

  const validation = validateAgentDefinitionText(
    currentString(content, "display_name"),
    currentString(content, "system_prompt"),
  );
  if (!validation.ok) {
    return { error: validation.error };
  }
  if (!changed) {
    return { error: "No changes to save." };
  }
  return {
    template: {
      kind: 30175,
      tags: latest.tags.map((tag) => [...tag]),
      content: JSON.stringify(content),
      created_at: Math.max(nowSecs, latest.created_at + 1),
    },
  };
}
