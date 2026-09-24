import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import { validateAgentDefinitionText } from "./definitionText.ts";
import { validateAllowlist, type RespondToMode } from "./respondToField.ts";
import type { TeamView } from "./teamEvents.ts";

/**
 * Web-side kind-30175 definition management: create, share/unshare, and
 * delete a standalone definition. Every event is byte-shaped like the
 * desktop's own publish (`persona_events.rs` `persona_event_content` /
 * `set_persona_shared` / `build_persona_delete`), so desktop's inbound
 * persona sync ingests it exactly like a desktop-originated change. No new
 * kinds, no new tags. Pure, React-free for the node runner.
 *
 * THE MANAGEABILITY RULE: the web mutates or deletes only coordinates whose
 * `d` is a canonical lowercase UUID — exactly the set desktop's own create
 * paths mint (`Uuid::new_v4()`). Team-installed personas (slug d-tags) and
 * built-ins are refused with "manage this in the desktop app". The web can't
 * see desktop's `source_team` / `source_dir` / `team_id`, so this is stricter
 * than desktop, never looser.
 */

export const UUID_D_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const OWNER_HEX_RE = /^[0-9a-f]{64}$/;

export interface NewDefinition {
  displayName: string;
  systemPrompt: string;
  avatarUrl: string;
  runtime: string;
  model: string;
  provider: string;
  respondTo: RespondToMode;
  respondToAllowlist: string[];
  parallelism: number | null;
}

export interface PersonaTemplate {
  kind: 30175;
  tags: string[][];
  content: string;
  created_at: number;
}

export interface DeletionTemplate {
  kind: 5;
  tags: [["a", string]];
  content: "";
  created_at: number;
}

/** Whether the web may mutate the coordinate with this `d`. */
export function webManageable(
  d: string,
): { ok: true } | { ok: false; reason: string } {
  if (UUID_D_RE.test(d)) {
    return { ok: true };
  }
  return {
    ok: false,
    reason:
      "This definition was installed with a team or built in — manage it in the desktop app.",
  };
}

/**
 * Build a fresh 30175 for a new standalone definition. Content key order is
 * `PersonaEventContent`'s serde order; `system_prompt` is always present
 * (desktop writes `Some("")`), `respond_to` is always written (the desktop
 * dialog always sends a mode), and the allowlist rides only in allowlist
 * mode. Tags carry no `shared` tag: desktop creates definitions unshared.
 */
export function buildPersonaCreate(
  input: NewDefinition,
  dTag: string,
  nowSecs: number,
): { template: PersonaTemplate } | { error: string } {
  if (!UUID_D_RE.test(dTag)) {
    return { error: "Internal error: the new definition id is not a UUID." };
  }
  const displayName = input.displayName.trim();
  if (displayName === "") {
    return { error: "Definition name is required." };
  }
  const validation = validateAgentDefinitionText(
    displayName,
    input.systemPrompt,
  );
  if (!validation.ok) {
    return { error: validation.error };
  }
  if (
    input.parallelism !== null &&
    (!Number.isInteger(input.parallelism) ||
      input.parallelism < 1 ||
      input.parallelism > 32)
  ) {
    return {
      error: `parallelism ${input.parallelism} is out of range (must be between 1 and 32)`,
    };
  }
  let allowlist: string[] = [];
  if (input.respondTo === "allowlist") {
    const entries = input.respondToAllowlist
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (entries.length === 0) {
      return {
        error:
          "respond-to mode 'allowlist' requires at least one pubkey in the allowlist",
      };
    }
    const bad = validateAllowlist(entries);
    if (bad) {
      return { error: bad };
    }
    allowlist = entries;
  }

  // Hardcoded serde order — do not reorder (it pins the content bytes).
  const content: Record<string, unknown> = {
    display_name: displayName,
    system_prompt: input.systemPrompt,
  };
  const optional = (key: string, value: string) => {
    const trimmed = value.trim();
    if (trimmed !== "") {
      content[key] = trimmed;
    }
  };
  optional("avatar_url", input.avatarUrl);
  optional("runtime", input.runtime);
  optional("model", input.model);
  optional("provider", input.provider);
  content.respond_to = input.respondTo;
  if (allowlist.length > 0) {
    content.respond_to_allowlist = allowlist;
  }
  if (input.parallelism !== null) {
    content.parallelism = input.parallelism;
  }
  return {
    template: {
      kind: 30175,
      tags: [["d", dTag]],
      content: JSON.stringify(content),
      created_at: nowSecs,
    },
  };
}

/**
 * Mirror of `buzz-core/src/kind.rs` `event_is_shared`: exactly one
 * `["shared","true"]`; any non-exact `shared` tag fails closed.
 */
export function isSharedEvent(event: Pick<SignedNostrEvent, "tags">): boolean {
  let count = 0;
  for (const tag of event.tags) {
    if (tag.length === 2 && tag[0] === "shared") {
      if (tag[1] !== "true") {
        return false;
      }
      count += 1;
    } else if (tag.length > 0 && tag[0] === "shared") {
      return false;
    }
  }
  return count === 1;
}

function parsedString(content: string, key: string): string {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return typeof parsed[key] === "string" ? (parsed[key] as string) : "";
  } catch {
    return "";
  }
}

/**
 * Republish the head with (or without) the `["shared","true"]` tag. Content
 * bytes are unchanged; every non-`shared` tag is copied in order; duplicate
 * or malformed `shared` tags are collapsed. Sharing runs the definition-text
 * check, as desktop does only when shared.
 */
export function buildShareToggle(
  latest: Pick<SignedNostrEvent, "content" | "tags" | "created_at">,
  shared: boolean,
  nowSecs: number,
): { template: PersonaTemplate } | { error: string } {
  if (isSharedEvent(latest) === shared) {
    return { error: shared ? "Already shared." : "Already private." };
  }
  if (shared) {
    const validation = validateAgentDefinitionText(
      parsedString(latest.content, "display_name"),
      parsedString(latest.content, "system_prompt"),
    );
    if (!validation.ok) {
      return { error: validation.error };
    }
  }
  const tags = latest.tags
    .filter((tag) => tag[0] !== "shared")
    .map((tag) => [...tag]);
  if (shared) {
    tags.push(["shared", "true"]);
  }
  return {
    template: {
      kind: 30175,
      tags,
      content: latest.content,
      created_at: Math.max(nowSecs, latest.created_at + 1),
    },
  };
}

type RosterLike = readonly {
  entry: { personaId: string | null };
  name: string;
}[];

/** The first reason the web must refuse to delete this definition, or null. */
export function deleteBlockers(
  personaId: string,
  personaName: string,
  roster: RosterLike,
  teams: ReadonlyMap<string, TeamView>,
): string | null {
  const manageable = webManageable(personaId);
  if (!manageable.ok) {
    return "This definition was installed with a team or built in — delete it in the desktop app.";
  }
  for (const team of teams.values()) {
    if (team.membershipUnknown) {
      return `Team "${team.name}" has a member list the web can't read, so ${personaName} might be in it. Check that team in the desktop app first.`;
    }
    if (team.personaIds.includes(personaId)) {
      return `${personaName} is still referenced by a team. Remove it from those teams first.`;
    }
  }
  const linked = roster.filter((row) => row.entry.personaId === personaId);
  if (linked.length > 0) {
    return `${linked.length} agent${linked.length === 1 ? "" : "s"} use${linked.length === 1 ? "s" : ""} this definition (${linked
      .map((row) => row.name)
      .join(", ")}). Delete those agents first.`;
  }
  return null;
}

/**
 * The NIP-09 coordinate tombstone, byte-identical to desktop's
 * `build_persona_delete` / `build_team_delete`: a single `a` tag, no `e`
 * tag (desktop's inbound routes kind 5 ONLY by `a`). `created_at` never
 * precedes the head, because the relay deletes only versions at or before
 * the tombstone and batch-1 monotonic edits can put the head in the future.
 * (Relay a-only deletion was verified live for 30175 and 30176 on
 * 2026-09-24 before this shape shipped.)
 */
export function buildCoordinateDelete(
  kind: 30175 | 30176,
  ownerHex: string,
  d: string,
  headCreatedAt: number,
  nowSecs: number,
): { template: DeletionTemplate } | { error: string } {
  if (!OWNER_HEX_RE.test(ownerHex)) {
    return { error: "Owner key must be 64 lowercase hex characters." };
  }
  if (d.length === 0) {
    return { error: "Coordinate d tag is empty." };
  }
  return {
    template: {
      kind: 5,
      tags: [["a", `${kind}:${ownerHex}:${d}`]],
      content: "",
      created_at: Math.max(nowSecs, headCreatedAt),
    },
  };
}
