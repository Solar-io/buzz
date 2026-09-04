/**
 * Slack-style search operators.
 *
 * `from:` / `in:` / `after:` / `before:` are lifted out of the query; what is
 * left is the NIP-50 `search` string the relay full-text-searches. Ported from
 * `desktop/src/features/search/lib/parseSearchOperators.ts` — the syntax has to
 * agree across clients, so this is a deliberate copy rather than a re-design.
 *
 * Two rules that look like details and are not:
 *
 * - Operators must begin at a **token boundary**, matched as `(?:^|\s)` and
 *   never `\b`. A word boundary also fires after `-` and `/`, which would turn
 *   `built-in:react` and `https://x.com/in:foo` into operators.
 * - An `after:`/`before:` value that is not `YYYY-MM-DD` is left in the text
 *   rather than silently dropped, so a typo degrades to a full-text search for
 *   the words the user typed instead of quietly widening the time range.
 *
 * Pure and import-free so `node --test` can load it directly.
 */

export interface ParsedSearchOperators {
  /** The query with operators removed — what the relay searches. */
  text: string;
  /** Raw `from:` value (hex, npub, `@name`), or null. */
  from: string | null;
  /** Raw `in:` value (channel id, `#name`), or null. */
  in: string | null;
  /** `after:YYYY-MM-DD` → unix seconds at local midnight (inclusive). */
  since: number | null;
  /**
   * `before:YYYY-MM-DD` → one second *before* local midnight.
   *
   * NIP-01 `until` is an inclusive upper bound, so stepping back a second is
   * what makes `before:` exclude the named day, matching Slack.
   */
  until: number | null;
}

const OPERATOR_RE = /(?:^|\s)(from|in|after|before):(\S+)/gi;

function parseLocalDayStart(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  // Round-trip check: `new Date(2025, 1, 30)` silently becomes 2 March.
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return Math.floor(date.getTime() / 1000);
}

/** Trailing punctuation, so `in:general,` still resolves to `general`. */
function cleanOperatorValue(value: string): string {
  return value.replace(/[.,;:!?]+$/g, "");
}

/** Extract the operators from `raw`. Later occurrences of one operator win. */
export function parseSearchOperators(raw: string): ParsedSearchOperators {
  let from: string | null = null;
  let inValue: string | null = null;
  let since: number | null = null;
  let until: number | null = null;

  const kept: string[] = [];
  let lastIndex = 0;

  for (const match of raw.matchAll(OPERATOR_RE)) {
    const index = match.index ?? 0;
    kept.push(raw.slice(lastIndex, index));
    lastIndex = index + match[0].length;

    const kind = match[1].toLowerCase();
    const value = cleanOperatorValue(match[2]);

    if (kind === "from") {
      from = value;
      continue;
    }
    if (kind === "in") {
      inValue = value;
      continue;
    }
    const parsed = parseLocalDayStart(value);
    if (parsed === null) {
      // Unparseable date: put the whole token back into the FTS text.
      kept.push(match[0]);
      continue;
    }
    if (kind === "after") {
      since = parsed;
    } else {
      until = parsed - 1;
    }
  }

  kept.push(raw.slice(lastIndex));

  return {
    text: kept.join("").replace(/\s+/g, " ").trim(),
    from,
    in: inValue,
    since,
    until,
  };
}

const HEX_PUBKEY_RE = /^[0-9a-f]{64}$/i;

export function isHexPubkey(value: string): boolean {
  return HEX_PUBKEY_RE.test(value);
}

/** Strip a leading `@` from a `from:` value. */
export function normalizeFromHandle(value: string): string {
  return value.startsWith("@") ? value.slice(1) : value;
}

/** Strip a leading `#` from an `in:` value. */
export function normalizeInChannel(value: string): string {
  return value.startsWith("#") ? value.slice(1) : value;
}

/**
 * Result of resolving an operator against local candidates.
 *
 * "No operator" and "operator present but unmatched" are separate states on
 * purpose: collapsing them makes `from:nobody` silently search *everyone*,
 * which is the opposite of what the user asked for.
 */
export type OperatorResolveResult<T> =
  | { status: "none" }
  | { status: "resolved"; value: T }
  | { status: "unresolved" };

export interface ChannelCandidate {
  id: string;
  name: string;
}

export interface PersonCandidate {
  pubkey: string;
  displayName?: string | null;
}

/** Resolve `in:` to a channel id: an exact id, else a case-insensitive name. */
export function resolveChannelOperator(
  raw: string | null,
  channels: readonly ChannelCandidate[],
): OperatorResolveResult<string> {
  if (!raw) {
    return { status: "none" };
  }
  const value = normalizeInChannel(raw);
  if (value.length === 0) {
    return { status: "none" };
  }
  const exactId = channels.find((channel) => channel.id === value);
  if (exactId) {
    return { status: "resolved", value: exactId.id };
  }
  const needle = value.toLowerCase();
  const byName = channels.find(
    (channel) => channel.name.toLowerCase() === needle,
  );
  return byName
    ? { status: "resolved", value: byName.id }
    : { status: "unresolved" };
}

/** Resolve `from:` to a pubkey: hex passes through, a handle is looked up. */
export function resolveAuthorOperator(
  raw: string | null,
  people: readonly PersonCandidate[],
): OperatorResolveResult<string> {
  if (!raw) {
    return { status: "none" };
  }
  if (isHexPubkey(raw)) {
    return { status: "resolved", value: raw.toLowerCase() };
  }
  const handle = normalizeFromHandle(raw).toLowerCase();
  if (handle.length === 0) {
    return { status: "unresolved" };
  }
  const match = people.find((person) => {
    if (person.pubkey.toLowerCase() === handle) {
      return true;
    }
    const name = person.displayName?.trim().toLowerCase();
    return name === handle;
  });
  return match
    ? { status: "resolved", value: match.pubkey.toLowerCase() }
    : { status: "unresolved" };
}
