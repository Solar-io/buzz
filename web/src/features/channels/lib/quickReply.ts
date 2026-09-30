/**
 * Quick replies: Yes / No buttons under a message that EXPLICITLY asks for
 * one (web redesign Phase 2).
 *
 * Conservative by construction. The buttons send a real reply in the viewer's
 * name, so a false positive is a button that answers a question nobody
 * asked — far worse than a missed one, which costs only the typing it always
 * cost. The detector therefore:
 *
 * - reads only the LAST line of the author's own prose (code fences and
 *   quoted lines are somebody else's words);
 * - accepts only a literal offer of the two choices there: an instruction
 *   ("Reply yes or no."), a question that ends on the choices ("…ship it,
 *   yes or no?"), or a question followed by them ("Ship it? (yes/no)");
 * - refuses a line that merely MENTIONS yes-or-no ("returns yes or no",
 *   "a yes or no question"), and refuses every question that does not offer
 *   the choices, however yes/no-shaped it reads.
 *
 * It never fabricates a card and never infers options from prose — agents
 * that want structured options send a decision card (`--card`). The fleet
 * base prompt tells them to end a yes/no question with the explicit choices,
 * which is exactly the shape accepted here.
 *
 * The fixture corpus (`quickReply.corpus.ts`) is the contract: every change
 * to a pattern must keep all positives detected and all negatives refused.
 *
 * Pure and import-free so `node --test` loads it directly.
 */

export type QuickReplyKind = "yesno";

/** The choices, spelled the way they are sent. */
export const YES_NO_CHOICES = ["Yes", "No"] as const;

const QUOTE = String.raw`["'“”‘’]?`;
/**
 * "yes or no" · "yes/no" · "y/n" — the literal offer, and ONLY those two: a
 * third choice ("yes, no or later") is not a yes/no question.
 */
const OFFER = String.raw`(?:${QUOTE}yes${QUOTE}\s*(?:or|\/)\s*${QUOTE}no${QUOTE}(?![a-z])|y\s*\/\s*n(?![a-z]))(?!\s*,?\s*or\b)`;

/**
 * "Reply yes or no." / "Answer with yes or no:" — an instruction to pick,
 * and an IMPERATIVE one: it opens the line or a sentence. "He didn't answer
 * yes or no" and "I'd say yes or no depending" describe; they do not ask.
 */
const INSTRUCTION = new RegExp(
  String.raw`(?:^|[.!?:;,—–]\s*)(?:so\s+)?(?:please\s+)?(?:just\s+)?(?:reply|answer|respond)(?:\s+(?:with|just|simply|either))*\s+${OFFER}`,
  "i",
);
/** A question, then the choices: "Ship it? (yes/no)" · "Ship it? Yes or no?" */
const QUESTION_THEN_OFFER = new RegExp(
  String.raw`\?\s*[\[(]?\s*${OFFER}\s*[\])]?\s*[.?]?$`,
  "i",
);
/** A question that ends on the choices: "Should I ship it, yes or no?" */
const ENDS_ON_OFFER = new RegExp(
  String.raw`(?:^|[,;:—–-])\s*(?:so\s+)?${OFFER}\s*\?$`,
  "i",
);
/** A parenthetical right before the question mark: "Ship it (y/n)?" */
const PAREN_OFFER = new RegExp(String.raw`[\[(]\s*${OFFER}\s*[\])]\s*\?$`, "i");

/** The author's own last line: code and quotes removed, markup stripped. */
function lastLine(content: string): string {
  let fenced = false;
  const lines: string[] = [];
  for (const raw of content.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || /^\s*>/.test(raw)) {
      continue;
    }
    const line = raw
      .replace(/`[^`\n]*`/g, " ")
      .replace(/(\*\*|__|[*_~])/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (line !== "") {
      lines.push(line);
    }
  }
  return lines[lines.length - 1] ?? "";
}

/** Does this message explicitly ask for a yes or a no? */
export function detectQuickReply(content: string): QuickReplyKind | null {
  const line = lastLine(content);
  if (line === "") {
    return null;
  }
  if (
    INSTRUCTION.test(line) ||
    QUESTION_THEN_OFFER.test(line) ||
    ENDS_ON_OFFER.test(line) ||
    PAREN_OFFER.test(line)
  ) {
    return "yesno";
  }
  return null;
}

/** The slice of a timeline message the open-question scan reads. */
export interface QuickReplyMessage {
  id: string;
  authorPubkey: string;
  createdAt: number;
  content: string;
  kind: number;
  mentionPubkeys: readonly string[];
  deleted?: boolean;
  card?: unknown;
  cardAnswer?: unknown;
}

/**
 * Message id → quick-reply kind, for the questions still OPEN to the viewer.
 *
 * Open means: someone else asked, it is aimed at me (it p-tags me, or this is
 * a DM), it is not a decision card (a card has its own answer surface), and I
 * have sent NOTHING in this conversation since. Once I say anything after it
 * the buttons go — I have either answered or moved on, and a button that
 * still offers "Yes" under a question I already replied to would send a
 * second, contradictory answer.
 */
export function openQuickReplies(
  messages: readonly QuickReplyMessage[],
  selfPubkey: string | null | undefined,
  options: { isDm: boolean },
): Map<string, QuickReplyKind> {
  const open = new Map<string, QuickReplyKind>();
  if (!selfPubkey) {
    return open;
  }
  const self = selfPubkey.toLowerCase();
  let myLatest = 0;
  for (const message of messages) {
    if (!message.deleted && message.authorPubkey.toLowerCase() === self) {
      myLatest = Math.max(myLatest, message.createdAt);
    }
  }
  for (const message of messages) {
    if (
      message.deleted ||
      message.kind !== 9 ||
      message.card != null ||
      message.cardAnswer != null ||
      message.authorPubkey.toLowerCase() === self ||
      message.createdAt <= myLatest
    ) {
      continue;
    }
    if (
      !options.isDm &&
      !message.mentionPubkeys.some((pubkey) => pubkey.toLowerCase() === self)
    ) {
      continue;
    }
    const kind = detectQuickReply(message.content);
    if (kind) {
      open.set(message.id, kind);
    }
  }
  return open;
}
