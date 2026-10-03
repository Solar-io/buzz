import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import { validateAgentDefinitionText } from "./definitionText.ts";
import { UUID_D_RE } from "./definitionManage.ts";
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
  /** Omitted by older editors; an empty list explicitly clears the pool. */
  namePool?: string[];
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

/** Read the desktop's ordered name list without changing its entries. */
export function personaNamePool(content: string): string[] {
  try {
    const parsed = JSON.parse(content);
    return Array.isArray(parsed?.name_pool) &&
      parsed.name_pool.every((name: unknown) => typeof name === "string")
      ? [...parsed.name_pool]
      : [];
  } catch {
    return [];
  }
}

/** Validate pool entries before normalization so invisible characters reject. */
function validateNamePool(names: readonly string[]): string | null {
  for (const name of names) {
    const result = validateAgentDefinitionText(name, "");
    if (!result.ok) return `Name pool: ${result.error}`;
  }
  return null;
}

/** Copy saved relay content to a fresh, private definition coordinate. */
export function buildPersonaDuplicate(
  latest: Pick<SignedNostrEvent, "content" | "tags">,
  id: string,
  nowSecs: number,
): { template: PersonaUpdateTemplate } | { error: string } {
  if (
    !UUID_D_RE.test(id) ||
    latest.tags.some((tag) => tag[0] === "d" && tag[1] === id)
  ) {
    return { error: "The copy needs a fresh definition id." };
  }
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
  if (
    (content.system_prompt !== undefined &&
      typeof content.system_prompt !== "string") ||
    (content.name_pool !== undefined &&
      (!Array.isArray(content.name_pool) ||
        !content.name_pool.every((name) => typeof name === "string")))
  ) {
    return {
      error: "The current definition has invalid instructions or names.",
    };
  }
  const validation = validateAgentDefinitionText(
    currentString(content, "display_name"),
    currentString(content, "system_prompt"),
  );
  if (!validation.ok) return { error: validation.error };
  content.display_name = `${content.display_name} (copy)`;
  const copyValidation = validateAgentDefinitionText(
    content.display_name as string,
    currentString(content, "system_prompt"),
  );
  if (!copyValidation.ok) return { error: copyValidation.error };
  const poolError = validateNamePool(personaNamePool(latest.content));
  if (poolError) return { error: poolError };
  return {
    template: {
      kind: 30175,
      tags: [
        ["d", id],
        ...latest.tags
          .filter((tag) => tag[0] !== "d" && tag[0] !== "shared")
          .map((tag) => [...tag]),
      ],
      content: JSON.stringify(content),
      created_at: nowSecs,
    },
  };
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
  // Validate the raw reviewed text BEFORE any normalization (rule 12).
  const rawValidation = validateAgentDefinitionText(
    edits.displayName,
    edits.systemPrompt,
  );
  if (!rawValidation.ok) return { error: rawValidation.error };
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
  setString("system_prompt", edits.systemPrompt, false);
  setString("model", edits.model.trim(), true);
  setString("provider", edits.provider.trim(), true);

  if (edits.namePool !== undefined) {
    const poolError = validateNamePool(edits.namePool);
    if (poolError) return { error: poolError };
    const names = edits.namePool.map((name) => name.trim());
    if (
      JSON.stringify(names) !== JSON.stringify(personaNamePool(latest.content))
    ) {
      changed = true;
      if (names.length === 0) delete content.name_pool;
      else content.name_pool = names;
    }
  }

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
