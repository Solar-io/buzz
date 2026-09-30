/**
 * ⌘K Jump (web redesign Phase 2; Jump artboard): scopes, the ranked rows,
 * and the inline ghost completion. Builds on `quickSwitcher.ts`'s matcher
 * (exact > prefix > word-prefix > substring — deliberately not fuzzy).
 *
 * The panel renders what this returns; nothing in the UI ranks, groups or
 * decides what Tab completes to.
 */

import { scoreQuickCandidate } from "./quickSwitcher.ts";

/** What the list is narrowed to. `#` `@` `/` as the first character pick one. */
export type JumpScope = "all" | "channel" | "person" | "command";

export interface JumpQuery {
  scope: JumpScope;
  /** The scope sigil as typed ("" for All) — Tab completion keeps it. */
  prefix: "" | "#" | "@" | "/";
  /** The text being matched, lowercased, without the sigil. */
  needle: string;
}

/** The scope chips, in strip order. `key` is the sigil a chip stands for. */
export const JUMP_SCOPES: readonly {
  id: JumpScope;
  label: string;
  key: JumpQuery["prefix"];
}[] = [
  { id: "all", label: "All", key: "" },
  { id: "channel", label: "Channels", key: "#" },
  { id: "person", label: "People", key: "@" },
  { id: "command", label: "Commands", key: "/" },
];

/** Read the scope sigil off the front of what was typed. */
export function parseJumpQuery(raw: string): JumpQuery {
  const text = raw.trimStart();
  const scope = JUMP_SCOPES.find(
    (entry) => entry.key !== "" && entry.key === text[0],
  );
  if (scope) {
    return {
      scope: scope.id,
      prefix: scope.key,
      needle: text.slice(1).trim().toLowerCase(),
    };
  }
  return { scope: "all", prefix: "", needle: text.trim().toLowerCase() };
}

/** What a scope chip puts in the field: its sigil plus the current needle. */
export function scopedJumpText(scope: JumpScope, needle: string): string {
  const key = JUMP_SCOPES.find((entry) => entry.id === scope)?.key ?? "";
  return `${key}${needle}`;
}

export type JumpKind = "channel" | "dm" | "person" | "action" | "command";

/** One thing ⌘K can jump to. */
export interface JumpCandidate {
  /** Stable key, unique across kinds ("channel:<id>", "action:inbox", …). */
  key: string;
  kind: JumpKind;
  label: string;
  /** Right-aligned status: "2 agents working", "private", "/remind". */
  hint?: string;
  /** The hint is a needs-you signal (drawn in coral). */
  hot?: boolean;
  keywords?: readonly string[];
  /** Tie-break between equally good matches; higher first. */
  weight?: number;
}

export interface JumpSection {
  header: string;
  items: JumpCandidate[];
}

export interface JumpResults {
  sections: JumpSection[];
  /** Every row in keyboard order. */
  flat: JumpCandidate[];
  /**
   * The rest of the top hit's label, shown as grey ghost text after the
   * caret; Tab accepts it. Empty unless the top hit STARTS with what was
   * typed — completing a substring match would rewrite the user's text
   * under their fingers.
   */
  ghost: string;
}

const GROUP_HEADER: Record<JumpKind, string> = {
  channel: "Channels",
  dm: "Direct messages",
  person: "People",
  command: "Commands",
  action: "Actions",
};
const GROUP_ORDER: readonly JumpKind[] = [
  "channel",
  "dm",
  "person",
  "command",
  "action",
];

function inScope(scope: JumpScope, kind: JumpKind): boolean {
  switch (scope) {
    case "all":
      return true;
    case "channel":
      return kind === "channel";
    case "person":
      return kind === "dm" || kind === "person";
    case "command":
      return kind === "action" || kind === "command";
  }
}

function grouped(items: readonly JumpCandidate[]): JumpSection[] {
  return GROUP_ORDER.flatMap((kind) => {
    const group = items.filter((item) => item.kind === kind);
    return group.length > 0
      ? [{ header: GROUP_HEADER[kind], items: group }]
      : [];
  });
}

function flatten(sections: readonly JumpSection[]): JumpCandidate[] {
  return sections.flatMap((section) => section.items);
}

/**
 * The palette's jump rows for a query.
 *
 * - Nothing typed, scope All → **Recent**: the conversations the viewer
 *   opened last, newest first (`recents` are candidate keys in that order).
 * - Nothing typed, a scope chosen → that scope's rows by weight.
 * - Otherwise → **Top hit**, then the remaining matches grouped by kind.
 */
export function buildJumpResults(input: {
  query: JumpQuery;
  candidates: readonly JumpCandidate[];
  /** Candidate keys, most recently opened first. */
  recents: readonly string[];
  limit?: number;
}): JumpResults {
  const { query, candidates, recents } = input;
  const limit = input.limit ?? 8;
  const scoped = candidates.filter((candidate) =>
    inScope(query.scope, candidate.kind),
  );

  if (query.needle === "") {
    if (query.scope === "all") {
      const byKey = new Map(
        scoped.map((candidate) => [candidate.key, candidate]),
      );
      const items = recents
        .flatMap((key) => {
          const candidate = byKey.get(key);
          return candidate ? [candidate] : [];
        })
        .slice(0, limit);
      return {
        sections: items.length > 0 ? [{ header: "Recent", items }] : [],
        flat: items,
        ghost: "",
      };
    }
    const sections = grouped(
      scoped
        .slice()
        .sort(
          (a, b) =>
            (b.weight ?? 0) - (a.weight ?? 0) || a.label.localeCompare(b.label),
        )
        .slice(0, limit * 2),
    );
    return { sections, flat: flatten(sections), ghost: "" };
  }

  const ranked = scoped
    .map((candidate) => ({
      candidate,
      score: scoreQuickCandidate(query.needle, {
        label: candidate.label,
        keywords: candidate.keywords ? [...candidate.keywords] : undefined,
      }),
    }))
    .filter((entry) => entry.score > 0)
    .map((entry) => ({
      candidate: entry.candidate,
      // Weight orders equal matches without ever promoting a substring hit
      // over a prefix hit (the same clamp as rankQuickTargets).
      score: entry.score + Math.min(entry.candidate.weight ?? 0, 9),
    }))
    .sort(
      (a, b) =>
        b.score - a.score || a.candidate.label.localeCompare(b.candidate.label),
    )
    .slice(0, limit)
    .map((entry) => entry.candidate);
  if (ranked.length === 0) {
    return { sections: [], flat: [], ghost: "" };
  }
  const [top, ...rest] = ranked;
  const sections = [{ header: "Top hit", items: [top] }, ...grouped(rest)];
  const ghost = top.label.toLowerCase().startsWith(query.needle)
    ? top.label.slice(query.needle.length)
    : "";
  return { sections, flat: flatten(sections), ghost };
}

/** Tab: the field's text with the ghost accepted (the sigil is kept). */
export function acceptJumpGhost(
  query: JumpQuery,
  results: JumpResults,
): string | null {
  const top = results.flat[0];
  if (!top || results.ghost === "") {
    return null;
  }
  return `${query.prefix}${top.label}`;
}

/**
 * Candidate keys for the Recent list from the sidebar's visit store: the
 * conversations opened most recently, newest first. (`at` is the last open;
 * the store's decayed score answers "most used", which is a different list.)
 */
export function recentJumpKeys(
  visits: Readonly<Record<string, { at: number }>>,
  limit = 8,
): string[] {
  return Object.entries(visits)
    .filter(([key]) => !key.startsWith("link:"))
    .sort(([keyA, a], [keyB, b]) => b.at - a.at || keyA.localeCompare(keyB))
    .slice(0, limit)
    .map(([key]) => `conversation:${key}`);
}
