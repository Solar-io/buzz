import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";

/**
 * Kind-30175 persona-definition reader — the source of the definition quad
 * (name / system prompt / model / provider) for definition-linked agent
 * instances. The web session IS the owner, and 30175 reads are
 * author-only-unless-shared, so an author-scoped subscription hydrates every
 * linked definition. Pure parse + merge, React-free for the node runner.
 */

export const PERSONA_KIND = 30175;

export interface PersonaDefinition {
  /** Persona id (the event's d tag slug). */
  id: string;
  name: string;
  systemPrompt: string;
  model: string;
  provider: string;
  /** Harness runtime id the definition pins, when present. */
  runtime: string;
  /** Event created_at — the merge key for replaceable updates. */
  updatedAt: number;
}

/** Parse one 30175 definition; null for wrong-shape events. */
export function personaFromEvent(
  event: SignedNostrEvent,
): PersonaDefinition | null {
  if (event.kind !== PERSONA_KIND) {
    return null;
  }
  const dTag = event.tags.find((tag) => tag[0] === "d")?.[1];
  if (!dTag || dTag.trim().length === 0) {
    return null;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(event.content) as Record<string, unknown>;
  } catch {
    return null;
  }
  const str = (key: string): string =>
    typeof parsed[key] === "string" ? (parsed[key] as string) : "";
  return {
    id: dTag,
    name: str("display_name") || dTag,
    systemPrompt: str("system_prompt"),
    model: str("model"),
    provider: str("provider"),
    runtime: str("runtime"),
    updatedAt: event.created_at,
  };
}

/** Newest-wins merge into a definition map (replaceable coordinate = id). */
export function mergePersona(
  personas: Map<string, PersonaDefinition>,
  persona: PersonaDefinition,
): Map<string, PersonaDefinition> {
  const existing = personas.get(persona.id);
  if (existing && existing.updatedAt >= persona.updatedAt) {
    return personas;
  }
  const next = new Map(personas);
  next.set(persona.id, persona);
  return next;
}
