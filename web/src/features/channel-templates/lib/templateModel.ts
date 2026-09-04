/**
 * Channel templates — the record model, its validation, and the on-disk wire
 * form the desktop client reads and writes.
 *
 * Templates are **local to a client**, exactly as on desktop: the desktop
 * keeps them in `<appData>/templates/channel-templates.json` (see
 * `desktop/src-tauri/src/templates/storage.rs`), never on the relay. A browser
 * has no such file, so the web store persists the same records in IndexedDB —
 * but the *wire form* here is byte-compatible with that file, which is what
 * makes export/import a genuine round-trip between the two clients rather
 * than a lookalike.
 *
 * Wire-shape rules mirrored from `desktop/src-tauri/src/templates/types.rs`:
 *
 * - `ChannelTemplateRecord` has **no** `rename_all`, so its fields are
 *   snake_case (`channel_type`, `canvas_template`, `is_builtin`, …).
 * - The roster structs DO carry `#[serde(rename_all = "camelCase")]`, so
 *   entries inside `agents` are `personaId` / `teamId`. The mixed casing is
 *   deliberate on their side; copying it is what keeps the files compatible.
 * - `description` and `canvas_template` are `skip_serializing_if =
 *   "Option::is_none"` — absent, never `null`.
 * - `agents.personas` / `agents.teams` are `skip_serializing_if =
 *   "Vec::is_empty"`, and `agents` itself is `#[serde(default)]`.
 * - `runtime` accepts the alias `provider` on read.
 *
 * This module is import-free on purpose so `node --test` can load it directly.
 */

export type ChannelTemplateType = "stream" | "forum";
export type ChannelTemplateVisibility = "open" | "private";

export type TemplateBackend =
  | { type: "local" }
  | { type: "provider"; id: string };

export interface TemplatePersonaEntry {
  personaId: string;
  runtime: string | null;
  model: string | null;
  role: string | null;
  backend: TemplateBackend | null;
}

export interface TemplateTeamEntry {
  teamId: string;
  runtime: string | null;
  model: string | null;
  backend: TemplateBackend | null;
}

export interface TemplateAgentRoster {
  personas: TemplatePersonaEntry[];
  teams: TemplateTeamEntry[];
}

export interface ChannelTemplate {
  id: string;
  name: string;
  description: string | null;
  channelType: ChannelTemplateType;
  visibility: ChannelTemplateVisibility;
  /**
   * Markdown seeded into the channel's canvas on desktop. The web client has
   * no canvas surface, so it stores and round-trips this field but never
   * applies it — see `applyTemplate.ts`.
   */
  canvasTemplate: string | null;
  agents: TemplateAgentRoster;
  isBuiltin: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelTemplateDraft {
  name: string;
  description: string;
  channelType: ChannelTemplateType;
  visibility: ChannelTemplateVisibility;
  canvasTemplate: string;
  agents: TemplateAgentRoster;
}

export const EMPTY_ROSTER: TemplateAgentRoster = { personas: [], teams: [] };

export function emptyDraft(): ChannelTemplateDraft {
  return {
    name: "",
    description: "",
    channelType: "stream",
    visibility: "open",
    canvasTemplate: "",
    agents: { personas: [], teams: [] },
  };
}

export function draftFromTemplate(
  template: ChannelTemplate,
): ChannelTemplateDraft {
  return {
    name: template.name,
    description: template.description ?? "",
    channelType: template.channelType,
    visibility: template.visibility,
    canvasTemplate: template.canvasTemplate ?? "",
    agents: {
      personas: template.agents.personas.map((entry) => ({ ...entry })),
      teams: template.agents.teams.map((entry) => ({ ...entry })),
    },
  };
}

function trimmedOrNull(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Validate a draft the way `commands/channel_templates.rs` does: a required,
 * trimmed name, and `channel_type` / `visibility` restricted to their two
 * legal values each. Returns the error string, or null when the draft is good.
 */
export function draftIssue(draft: ChannelTemplateDraft): string | null {
  if (draft.name.trim().length === 0) {
    return "Template name is required";
  }
  if (draft.channelType !== "stream" && draft.channelType !== "forum") {
    return `invalid channel type: "${String(draft.channelType)}" (expected "stream" or "forum")`;
  }
  if (draft.visibility !== "open" && draft.visibility !== "private") {
    return `invalid visibility: "${String(draft.visibility)}" (expected "open" or "private")`;
  }
  return null;
}

/**
 * Sort order copied from `sort_channel_templates`: built-ins first, then
 * case-insensitive name, then id as the tie-break.
 */
export function sortTemplates(records: ChannelTemplate[]): ChannelTemplate[] {
  return [...records].sort((left, right) => {
    const leftBuiltin = left.isBuiltin ? 0 : 1;
    const rightBuiltin = right.isBuiltin ? 0 : 1;
    if (leftBuiltin !== rightBuiltin) return leftBuiltin - rightBuiltin;
    const byName = left.name
      .toLowerCase()
      .localeCompare(right.name.toLowerCase());
    if (byName !== 0) return byName;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

/** Built-ins cannot be deleted — `validate_channel_template_deletion`. */
export function deletionIssue(template: ChannelTemplate): string | null {
  return template.isBuiltin ? "Built-in templates cannot be deleted." : null;
}

// ── Wire form (desktop `channel-templates.json`) ────────────────────────────

function backendFromWire(value: unknown): TemplateBackend | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (raw.type === "local") return { type: "local" };
  if (raw.type === "provider" && typeof raw.id === "string") {
    return { type: "provider", id: raw.id };
  }
  return null;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * `runtime` with the serde `alias = "provider"` honoured, so a record written
 * by an older desktop still resolves its harness choice.
 */
function runtimeFromWire(raw: Record<string, unknown>): string | null {
  return optionalText(raw.runtime) ?? optionalText(raw.provider);
}

function rosterFromWire(value: unknown): TemplateAgentRoster {
  if (typeof value !== "object" || value === null) return EMPTY_ROSTER;
  const raw = value as Record<string, unknown>;
  const personas: TemplatePersonaEntry[] = [];
  const teams: TemplateTeamEntry[] = [];
  if (Array.isArray(raw.personas)) {
    for (const entry of raw.personas) {
      if (typeof entry !== "object" || entry === null) continue;
      const row = entry as Record<string, unknown>;
      if (typeof row.personaId !== "string" || row.personaId.length === 0) {
        continue;
      }
      personas.push({
        personaId: row.personaId,
        runtime: runtimeFromWire(row),
        model: optionalText(row.model),
        role: optionalText(row.role),
        backend: backendFromWire(row.backend),
      });
    }
  }
  if (Array.isArray(raw.teams)) {
    for (const entry of raw.teams) {
      if (typeof entry !== "object" || entry === null) continue;
      const row = entry as Record<string, unknown>;
      if (typeof row.teamId !== "string" || row.teamId.length === 0) continue;
      teams.push({
        teamId: row.teamId,
        runtime: runtimeFromWire(row),
        model: optionalText(row.model),
        backend: backendFromWire(row.backend),
      });
    }
  }
  return { personas, teams };
}

/**
 * Parse one record from the desktop's JSON file. Returns null for anything
 * that could not be a template, so a partially corrupt file still imports the
 * records it does understand instead of failing whole.
 */
export function templateFromWire(value: unknown): ChannelTemplate | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || raw.id.length === 0) return null;
  if (typeof raw.name !== "string" || raw.name.trim().length === 0) return null;

  const channelType = raw.channel_type === "forum" ? "forum" : "stream";
  const visibility = raw.visibility === "private" ? "private" : "open";

  return {
    id: raw.id,
    name: raw.name,
    description: trimmedOrNull(optionalText(raw.description)),
    channelType,
    visibility,
    canvasTemplate: optionalText(raw.canvas_template),
    agents: rosterFromWire(raw.agents),
    isBuiltin: raw.is_builtin === true,
    createdAt:
      typeof raw.created_at === "string"
        ? raw.created_at
        : new Date(0).toISOString(),
    updatedAt:
      typeof raw.updated_at === "string"
        ? raw.updated_at
        : new Date(0).toISOString(),
  };
}

function backendToWire(backend: TemplateBackend | null) {
  if (!backend) return undefined;
  return backend.type === "local"
    ? { type: "local" }
    : { type: "provider", id: backend.id };
}

function rosterToWire(roster: TemplateAgentRoster) {
  const out: Record<string, unknown> = {};
  if (roster.personas.length > 0) {
    out.personas = roster.personas.map((entry) => ({
      personaId: entry.personaId,
      ...(entry.runtime ? { runtime: entry.runtime } : {}),
      ...(entry.model ? { model: entry.model } : {}),
      ...(entry.role ? { role: entry.role } : {}),
      ...(entry.backend ? { backend: backendToWire(entry.backend) } : {}),
    }));
  }
  if (roster.teams.length > 0) {
    out.teams = roster.teams.map((entry) => ({
      teamId: entry.teamId,
      ...(entry.runtime ? { runtime: entry.runtime } : {}),
      ...(entry.model ? { model: entry.model } : {}),
      ...(entry.backend ? { backend: backendToWire(entry.backend) } : {}),
    }));
  }
  return out;
}

/**
 * Serialise one record in the desktop's exact shape — snake_case at the top
 * level, camelCase inside `agents`, and absent (not null) optionals.
 */
export function templateToWire(
  template: ChannelTemplate,
): Record<string, unknown> {
  return {
    id: template.id,
    name: template.name,
    ...(template.description ? { description: template.description } : {}),
    channel_type: template.channelType,
    visibility: template.visibility,
    ...(template.canvasTemplate
      ? { canvas_template: template.canvasTemplate }
      : {}),
    agents: rosterToWire(template.agents),
    is_builtin: template.isBuiltin,
    created_at: template.createdAt,
    updated_at: template.updatedAt,
  };
}

/** The whole file the desktop reads: a bare, sorted JSON array. */
export function serializeTemplates(templates: ChannelTemplate[]): string {
  return `${JSON.stringify(sortTemplates(templates).map(templateToWire), null, 2)}\n`;
}

/**
 * Parse an exported file. Accepts the bare array the desktop writes and also
 * a single record, because a user pasting one template is the obvious mistake
 * and rejecting it teaches nothing.
 */
export function parseTemplatesFile(text: string): ChannelTemplate[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const out: ChannelTemplate[] = [];
  for (const row of rows) {
    const template = templateFromWire(row);
    if (template) out.push(template);
  }
  return out;
}

/**
 * Merge imported records into the existing set, newest-`updated_at` wins per
 * id. Imported records are never marked built-in: `is_builtin` is a property
 * of *this* client's seeds, and honouring it from a file would let an import
 * mint an undeletable template.
 */
export function mergeImported(
  existing: ChannelTemplate[],
  imported: ChannelTemplate[],
): ChannelTemplate[] {
  const byId = new Map(existing.map((t) => [t.id, t]));
  for (const row of imported) {
    const current = byId.get(row.id);
    const candidate: ChannelTemplate = { ...row, isBuiltin: false };
    if (!current) {
      byId.set(row.id, candidate);
      continue;
    }
    if (current.isBuiltin) continue;
    if (candidate.updatedAt >= current.updatedAt) {
      byId.set(row.id, candidate);
    }
  }
  return sortTemplates([...byId.values()]);
}
