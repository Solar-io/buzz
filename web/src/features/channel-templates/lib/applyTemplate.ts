/**
 * Turning a template into wire events — the pure half of "use this template".
 *
 * Three things come out of applying a template, and all three are event or
 * command shapes rather than side effects, so the exact tags can be pinned by
 * a test rather than inspected in a relay log:
 *
 * 1. a kind-9007 create-channel event (`build_create_channel`, desktop
 *    `events.rs:97`),
 * 2. one create-agent admin command per rostered persona (kind 24201, the
 *    web→desktop channel in `features/agents/lib/adminCommands.ts`), and
 * 3. a kind-9000 add-member event per agent that comes back, so the roster
 *    lands *in the channel* rather than merely existing (`build_add_member`,
 *    desktop `events.rs:222` / `buzz-sdk/src/builders.rs:575`).
 *
 * What is deliberately absent: the canvas. `useApplyTemplate.ts` on desktop
 * calls `setCanvas` with the interpolated `canvasTemplate`; the web client has
 * no canvas surface at all, so `canvasBody` below renders the interpolation
 * for display and export and nothing applies it. Interpolating it here anyway
 * keeps the field honest for the desktop round-trip.
 *
 * Import-free apart from sibling `.ts` modules, so `node --test` loads it.
 */

import type {
  ChannelTemplate,
  TemplateBackend,
  TemplateAgentRoster,
} from "./templateModel.ts";

/** `buzz-core::canonical_channel_name` — strip leading #/space, trim the end. */
export function canonicalChannelName(name: string): string {
  return name.replace(/^[#\s]+/, "").replace(/\s+$/, "");
}

export interface UnsignedEventTemplate {
  kind: number;
  tags: string[][];
  content: string;
}

/**
 * The kind-9007 create-channel event for a template.
 *
 * `channel_type` is included because the template can say "forum" — the tag
 * the web client's own New Channel dialog never sends, which is why a forum
 * could not be created from the browser before this.
 */
export function buildCreateChannelEvent(input: {
  channelId: string;
  name: string;
  template: Pick<
    ChannelTemplate,
    "channelType" | "visibility" | "description"
  > | null;
}): { event: UnsignedEventTemplate } | { error: string } {
  const name = canonicalChannelName(input.name);
  if (name.length === 0) {
    return { error: "channel name is required" };
  }
  if (input.channelId.length === 0) {
    return { error: "channel id is required" };
  }
  const visibility = input.template?.visibility ?? "open";
  const channelType = input.template?.channelType ?? "stream";
  const about = input.template?.description ?? null;
  const tags: string[][] = [
    ["h", input.channelId],
    ["name", name],
    ["visibility", visibility],
    ["channel_type", channelType],
  ];
  if (about) tags.push(["about", about]);
  return { event: { kind: 9007, tags, content: "" } };
}

const PUBKEY_RE = /^[0-9a-f]{64}$/;

/** Kind 9000 — add `pubkey` to `channelId`, optionally with a role. */
export function buildAddMemberEvent(input: {
  channelId: string;
  pubkey: string;
  role?: "admin" | "bot" | "guest" | "member";
}): { event: UnsignedEventTemplate } | { error: string } {
  const pubkey = input.pubkey.toLowerCase();
  if (!PUBKEY_RE.test(pubkey)) {
    return { error: "target_pubkey must be 64 hex characters" };
  }
  if (input.channelId.length === 0) {
    return { error: "channel id is required" };
  }
  const tags: string[][] = [
    ["h", input.channelId],
    ["p", pubkey],
  ];
  // "member" is the relay's default and is sent as no tag at all, matching
  // `add_channel_members`, which maps Some("member") | None to None.
  if (input.role && input.role !== "member") {
    tags.push(["role", input.role]);
  }
  return { event: { kind: 9000, tags, content: "" } };
}

/** The persona fields the applier needs; a subset of `PersonaDefinition`. */
export interface RosterPersona {
  id: string;
  name: string;
  systemPrompt: string;
  model: string;
  provider: string;
  runtime: string;
}

/** The team fields the applier needs; a subset of `TeamView`. */
export interface RosterTeam {
  id: string;
  personaIds: string[];
}

/**
 * The subset of `CreateAgentRequest` a template can populate. Fields the
 * template has nothing to say about (env vars, timeouts, allowlists) are left
 * off so the desktop applies its own defaults, exactly as the desktop
 * template applier does.
 */
export interface TemplateAgentSpec {
  personaId: string;
  name: string;
  systemPrompt: string;
  model?: string;
  provider?: string;
  harness?: { kind: "preset"; runtimeId: string };
  role: "bot";
}

function harnessFor(
  runtime: string | null,
  personaRuntime: string,
): { kind: "preset"; runtimeId: string } | undefined {
  const runtimeId = (runtime ?? personaRuntime ?? "").trim();
  return runtimeId.length > 0 ? { kind: "preset", runtimeId } : undefined;
}

function providerFor(
  backend: TemplateBackend | null,
  personaProvider: string,
): string | undefined {
  if (backend && backend.type === "provider" && backend.id.trim().length > 0) {
    return backend.id.trim();
  }
  const fallback = personaProvider.trim();
  return fallback.length > 0 ? fallback : undefined;
}

/**
 * Expand a roster into agent specs.
 *
 * Mirrors `useApplyTemplate.applyAgents`: direct personas first, then
 * team-expanded personas, de-duplicated by persona id across BOTH passes so a
 * persona listed directly and also via a team is provisioned once. Entries
 * naming a persona or team this client cannot see are skipped rather than
 * failing the apply — the desktop does the same, and a persona can legitimately
 * be missing while its 30175 has not arrived.
 */
export function expandRoster(
  roster: TemplateAgentRoster,
  catalog: { personas: RosterPersona[]; teams: RosterTeam[] },
): { specs: TemplateAgentSpec[]; skipped: string[] } {
  const personaById = new Map(catalog.personas.map((p) => [p.id, p]));
  const teamById = new Map(catalog.teams.map((t) => [t.id, t]));
  const seen = new Set<string>();
  const specs: TemplateAgentSpec[] = [];
  const skipped: string[] = [];

  const push = (
    persona: RosterPersona,
    runtime: string | null,
    model: string | null,
    backend: TemplateBackend | null,
  ) => {
    if (seen.has(persona.id)) return;
    seen.add(persona.id);
    const resolvedModel = (model ?? persona.model ?? "").trim();
    specs.push({
      personaId: persona.id,
      name: persona.name,
      systemPrompt: persona.systemPrompt,
      ...(resolvedModel.length > 0 ? { model: resolvedModel } : {}),
      ...(providerFor(backend, persona.provider)
        ? { provider: providerFor(backend, persona.provider) as string }
        : {}),
      ...(harnessFor(runtime, persona.runtime)
        ? {
            harness: harnessFor(runtime, persona.runtime) as {
              kind: "preset";
              runtimeId: string;
            },
          }
        : {}),
      role: "bot",
    });
  };

  for (const entry of roster.personas) {
    const persona = personaById.get(entry.personaId);
    if (!persona) {
      skipped.push(entry.personaId);
      continue;
    }
    push(persona, entry.runtime, entry.model, entry.backend);
  }

  for (const entry of roster.teams) {
    const team = teamById.get(entry.teamId);
    if (!team) {
      skipped.push(entry.teamId);
      continue;
    }
    for (const personaId of team.personaIds) {
      const persona = personaById.get(personaId);
      if (!persona) {
        skipped.push(personaId);
        continue;
      }
      push(persona, entry.runtime, entry.model, entry.backend);
    }
  }

  return { specs, skipped };
}

/**
 * `{channel.name}` / `{template.name}` interpolation, copied from
 * `useApplyTemplate.applyCanvas`. Kept because it is what makes the stored
 * canvas field meaningful on the desktop side of an export.
 */
export function canvasBody(
  template: Pick<ChannelTemplate, "canvasTemplate" | "name">,
  channelName: string,
): string | null {
  if (!template.canvasTemplate) return null;
  return template.canvasTemplate
    .replace(/\{channel\.name\}/g, channelName)
    .replace(/\{template\.name\}/g, template.name);
}
