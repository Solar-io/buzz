/** The first useful plain-text line of a Work message, capped at 200 chars. */
export function cleanWorkText(content: string): string {
  for (const part of content.split("\n")) {
    let line = part
      .replace(/\*\*|__|`/g, "")
      .replace(/\s+/g, " ")
      .trim();
    // Strip tokens, not guessed multi-word profile names. Keep sentence text.
    line = line.replace(/^(?:(?:nostr:npub[0-9a-z]+|@[\w-]+)[,:]?\s*)+/i, "");
    line = line
      .replace(
        /^(?:\p{Extended_Pictographic}|\uFE0F|\u200D|\s)+(?:updates?|issues?|questions?|status|progress|summary)\s*:\s*/iu,
        "",
      )
      .trim();
    if (line) {
      return line.length > 200 ? `${line.slice(0, 199)}…` : line;
    }
  }
  return "";
}

/** Short acknowledgements and pointers need their reply parent's context. */
export function isShortTrigger(text: string): boolean {
  const line = cleanWorkText(text);
  return (
    line.split(/\s+/).length <= 4 ||
    /^(yes|no|ok(ay)?|sure|go|do it|do option \d+|option \d+|see (my )?(message|above).*|\[voice\].{0,40})[.!?]?$/i.test(
      line,
    )
  );
}

/** NIP-10: prefer reply, then root, then the last legacy e tag. */
export function replyParentId(tags: readonly string[][]): string | null {
  const refs = tags.filter((tag) => tag[0] === "e" && tag[1]);
  return (
    refs.find((tag) => tag[3] === "reply")?.[1] ??
    refs.find((tag) => tag[3] === "root")?.[1] ??
    refs[refs.length - 1]?.[1] ??
    null
  );
}
