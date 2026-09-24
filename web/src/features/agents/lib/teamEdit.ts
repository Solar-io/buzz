import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import { UUID_D_RE } from "./definitionManage.ts";
import type { TeamView } from "./teamEvents.ts";

/**
 * Web-side kind-30176 team create / update / delete-guard. Mirrors the
 * desktop's `create_team` → `team_event_content` → `build_team_event` for
 * create, and the inbound reconcile (`commit_inbound_team`) for update:
 * desktop overwrites name/description, and instructions/persona_ids ONLY when
 * present — absent means "preserve local". So an update must never introduce
 * a key the user didn't edit, and must never turn an unknown membership into
 * an explicit list (the Sietch Tabr wipe). Pure, React-free.
 */

export interface TeamEdits {
  name: string;
  description: string;
  instructions: string;
  /** null = membership untouched (the key is left exactly as it was). */
  personaIds: string[] | null;
}

export interface TeamTemplate {
  kind: 30176;
  tags: string[][];
  content: string;
  created_at: number;
}

function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Fresh team. Content is hardcoded in `TeamEventContent` serde order:
 * name, description? (skipped when None), instructions (always present,
 * `null` when blank), persona_ids (always present, even `[]`).
 */
export function buildTeamCreate(
  edits: TeamEdits,
  dTag: string,
  nowSecs: number,
): { template: TeamTemplate } | { error: string } {
  if (!UUID_D_RE.test(dTag)) {
    return { error: "Internal error: the new team id is not a UUID." };
  }
  const name = edits.name.trim();
  if (name === "") {
    return { error: "Team name is required" };
  }
  const content: Record<string, unknown> = { name };
  const description = blankToNull(edits.description);
  if (description !== null) {
    content.description = description;
  }
  content.instructions = blankToNull(edits.instructions);
  content.persona_ids = [...(edits.personaIds ?? [])];
  return {
    template: {
      kind: 30176,
      tags: [["d", dTag]],
      content: JSON.stringify(content),
      created_at: nowSecs,
    },
  };
}

function sameIds(left: unknown, right: readonly string[]): boolean {
  return (
    Array.isArray(left) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

/**
 * Republish the head with only the edited keys rewritten. Unchanged keys keep
 * their value and position; unknown keys and every tag survive. An absent
 * `instructions` / `persona_ids` key stays absent unless that field is edited.
 */
export function buildTeamUpdate(
  latest: Pick<SignedNostrEvent, "content" | "tags" | "created_at">,
  edits: TeamEdits,
  nowSecs: number,
): { template: TeamTemplate } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(latest.content);
  } catch {
    return { error: "The current team is not valid JSON." };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "The current team is not a JSON object." };
  }
  const content = parsed as Record<string, unknown>;
  let changed = false;

  const name = edits.name.trim();
  if (name === "") {
    return { error: "Team name is required" };
  }
  if (content.name !== name) {
    content.name = name;
    changed = true;
  }

  const description = blankToNull(edits.description);
  const currentDescription =
    typeof content.description === "string" ? content.description : null;
  if (description !== currentDescription) {
    if (description === null) {
      delete content.description;
    } else {
      content.description = description;
    }
    changed = true;
  }

  const instructions = blankToNull(edits.instructions);
  const currentInstructions =
    typeof content.instructions === "string" ? content.instructions : null;
  if (instructions !== currentInstructions) {
    content.instructions = instructions;
    changed = true;
  }

  if (
    edits.personaIds !== null &&
    !sameIds(content.persona_ids, edits.personaIds)
  ) {
    content.persona_ids = [...edits.personaIds];
    changed = true;
  }

  if (!changed) {
    return { error: "No changes to save." };
  }
  return {
    template: {
      kind: 30176,
      tags: latest.tags.map((tag) => [...tag]),
      content: JSON.stringify(content),
      created_at: Math.max(nowSecs, latest.created_at + 1),
    },
  };
}

/**
 * The full persona_ids list to publish from the editor: the toggled
 * selection over resolved (visible) definitions, plus every unresolved id
 * from the head untouched, in their original order first.
 */
export function mergeMemberSelection(
  currentIds: readonly string[],
  resolvedIds: ReadonlySet<string>,
  selected: ReadonlySet<string>,
): string[] {
  const kept = currentIds.filter(
    (id) => !resolvedIds.has(id) || selected.has(id),
  );
  const added = [...selected].filter((id) => !currentIds.includes(id));
  return [...kept, ...added];
}

/** The first reason the web must refuse to delete this team, or null. */
export function teamDeleteBlockers(
  team: Pick<TeamView, "id" | "membershipUnknown" | "personaIds">,
  roster: readonly { entry: { personaId: string | null }; name: string }[],
): string | null {
  if (!UUID_D_RE.test(team.id) || team.membershipUnknown) {
    return "Delete this team in the desktop app.";
  }
  const members = new Set(team.personaIds);
  const referencing = roster.filter(
    (row) => row.entry.personaId !== null && members.has(row.entry.personaId),
  );
  if (referencing.length > 0) {
    return `Cannot delete team: ${referencing.length} agent(s) still reference it (${referencing
      .map((row) => row.name)
      .join(", ")}). Delete or reconfigure them first.`;
  }
  return null;
}
