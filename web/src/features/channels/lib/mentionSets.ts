/**
 * Set-equality for MarkdownContent's memo comparator. Mention sets are
 * tiny (the message's p-tags), so this is far cheaper than the
 * alternative: busting the memo re-parses react-markdown for EVERY message
 * on EVERY parent render, which turned a 450-message DM into a
 * minutes-long renderer freeze (live incident 2026-08-29 — fresh Set
 * identity defeated memo's default shallow compare).
 */
export function mentionSetsEqual(
  a: ReadonlySet<string>,
  b: ReadonlySet<string>,
): boolean {
  if (a === b) {
    return true;
  }
  if (a.size !== b.size) {
    return false;
  }
  for (const name of a) {
    if (!b.has(name)) {
      return false;
    }
  }
  return true;
}
