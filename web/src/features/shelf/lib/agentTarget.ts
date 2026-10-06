/**
 * Who the Canvas agent box talks to (canvas edit plan D10):
 *
 *   - the share's author, when the author is an agent;
 *   - otherwise a "To:" picker over the channel's agent MEMBERS (a mention
 *     must name a member — the relay refuses anyone else), defaulting to the
 *     last agent that replied in this file's thread, then the only agent;
 *     with neither, the person picks before Send enables;
 *   - with no agent in the channel, the box posts a plain note (and, as
 *     before this change, wakes the share's author when that is not you).
 *
 * Pure so `node --test` loads it directly.
 */

export type AgentTarget =
  | { mode: "author"; target: string }
  | { mode: "picker"; options: string[]; target: string | null }
  | { mode: "note"; target: null };

export function agentTarget(input: {
  authorPubkey: string;
  selfPubkey: string | null;
  /** Channel member pubkeys (any order). */
  memberPubkeys: readonly string[];
  isAgent: (pubkey: string) => boolean;
  /** Thread replies, oldest first. */
  comments: readonly { authorPubkey: string }[];
  /** The person's explicit choice in the picker, if any. */
  picked: string | null;
}): AgentTarget {
  const { authorPubkey, selfPubkey, isAgent } = input;
  if (authorPubkey !== selfPubkey && isAgent(authorPubkey)) {
    return { mode: "author", target: authorPubkey };
  }
  const options = [
    ...new Set(
      input.memberPubkeys.filter(
        (pubkey) => pubkey !== selfPubkey && isAgent(pubkey),
      ),
    ),
  ];
  if (options.length === 0) {
    return { mode: "note", target: null };
  }
  if (input.picked && options.includes(input.picked)) {
    return { mode: "picker", options, target: input.picked };
  }
  for (let i = input.comments.length - 1; i >= 0; i -= 1) {
    const author = input.comments[i].authorPubkey;
    if (options.includes(author)) {
      return { mode: "picker", options, target: author };
    }
  }
  return {
    mode: "picker",
    options,
    target: options.length === 1 ? options[0] : null,
  };
}

/** The `p` tags the reply carries. */
export function mentionsFor(
  target: AgentTarget,
  authorPubkey: string,
  selfPubkey: string | null,
): string[] {
  if (target.mode === "note") {
    return authorPubkey !== selfPubkey ? [authorPubkey] : [];
  }
  return target.target ? [target.target] : [];
}
