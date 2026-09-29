/**
 * Who a thread reply notifies without a typed @ — the one person the viewer
 * is unambiguously talking to, or null.
 *
 * 1. Two-person threads (Sam 2026-09-20): the viewer has posted and exactly
 *    one other person has — that person, human or agent.
 * 2. "The agent I'm talking with" (Sam 2026-09-29): his real thread had an
 *    earlier second agent in it, so rule 1 refused it and every reply needed
 *    a tag. The partner is the agent who posted most recently — unless two or
 *    more different agents have posted since the viewer's last message, which
 *    is a live multi-agent exchange where a default would be a guess.
 *    Humans are never picked by this rule.
 *
 * Computed over live (non-deleted) messages, oldest first.
 */
export function threadPartner(
  messages: readonly { authorPubkey: string; deleted?: boolean }[],
  selfPubkey: string,
  agentPubkeys?: ReadonlySet<string>,
): string | null {
  const live = messages.filter((message) => !message.deleted);
  const authors = new Set(live.map((message) => message.authorPubkey));
  if (authors.size === 2 && authors.has(selfPubkey)) {
    return [...authors].find((pubkey) => pubkey !== selfPubkey) ?? null;
  }
  if (!agentPubkeys) return null;

  let lastOwn = -1;
  live.forEach((message, index) => {
    if (message.authorPubkey === selfPubkey) lastOwn = index;
  });
  const agentsSinceOwn = new Set(
    live
      .slice(lastOwn + 1)
      .map((message) => message.authorPubkey)
      .filter((pubkey) => agentPubkeys.has(pubkey)),
  );
  // Never posted: only the newest agent counts, so an old second voice in
  // the thread doesn't block the default.
  if (lastOwn !== -1 && agentsSinceOwn.size > 1) return null;

  for (let index = live.length - 1; index >= 0; index -= 1) {
    const author = live[index].authorPubkey;
    if (author !== selfPubkey && agentPubkeys.has(author)) return author;
  }
  return null;
}
