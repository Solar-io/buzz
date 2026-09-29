/**
 * Who a thread reply notifies without a typed @ — the one person the viewer
 * is unambiguously talking to, or null.
 *
 * Two-person threads (Sam 2026-09-20) were the first rule: authors ∪ {self}
 * exactly two. It missed the thread Sam actually has (2026-09-29): an agent
 * posts, a second agent answers once, then Sam and the first agent talk for
 * hours — three authors, so every one of Sam's replies had to be tagged.
 *
 * The partner is computed over live (non-deleted) messages, oldest first:
 * - Viewer has posted: every other author since the viewer's first post.
 *   Exactly one → that person. If nobody has answered yet, the author of the
 *   message right before the viewer's first post (whom they answered).
 *   Voices from before the viewer joined don't count once someone replies.
 * - Viewer never posted: every other author. Exactly one AND an agent → that
 *   agent (replying to an agent's post is addressing it). A human-only thread
 *   still waits for the viewer's first post, as before.
 */
export function threadPartner(
  messages: readonly { authorPubkey: string; deleted?: boolean }[],
  selfPubkey: string,
  agentPubkeys?: ReadonlySet<string>,
): string | null {
  const live = messages.filter((message) => !message.deleted);
  const firstOwn = live.findIndex(
    (message) => message.authorPubkey === selfPubkey,
  );
  const others = new Set<string>();
  if (firstOwn === -1) {
    for (const message of live) others.add(message.authorPubkey);
  } else {
    for (const message of live.slice(firstOwn + 1)) {
      if (message.authorPubkey !== selfPubkey) others.add(message.authorPubkey);
    }
    // Nobody has answered the viewer yet: the partner is whoever they
    // answered — the message right before their first post.
    if (others.size === 0 && firstOwn > 0) {
      others.add(live[firstOwn - 1].authorPubkey);
    }
  }
  if (others.size !== 1) return null;
  const [partner] = others;
  if (firstOwn === -1 && !agentPubkeys?.has(partner)) return null;
  return partner;
}
