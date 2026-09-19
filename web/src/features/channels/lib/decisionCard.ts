/**
 * D-035 decision cards: a structured question rendered as a tappable card —
 * bold title, body, 2+ options with an optional "Recommended" marker, plus
 * type-your-own. The ask is Sam's (10:36 CDT 9/16): one-tap answers to agent
 * questions, in all DMs and all channels.
 *
 * Wire shape (kind 9 + card tag — relay passes author tags through verbatim,
 * they are signature-covered): ordinary kind 9 whose CONTENT is a
 * human-readable fallback every plain client (including the desktop app)
 * renders on its own, plus one tag
 *
 *   ["card", "<compact JSON>"]
 *
 * carrying the structure. The SPA renders the card when the tag parses and
 * the fallback content otherwise — malformed payloads degrade to plain text,
 * never to a broken card. Replies are ordinary kind 9 replies (NIP-10 e-tag
 * to the card event) whose content is the chosen option's label verbatim, so
 * every client reads them and the thread view groups them for free.
 *
 * Payload: {"v":1,"title":string,"body"?:string,
 *           "options":[{"id"?:string,"label":string,"recommended"?:boolean}]}
 */

/** Hard bounds — the parse rejects anything outside them. */
export const CARD_LIMITS = {
  /** Card tag JSON, in bytes — client-side self-cap (Richard 9/16: the relay
   * has no generic per-tag bound, so the authoring side owns this). Generous
   * against the options, tiny against the kind 9 content cap (61,440) so a
   * card can never crowd out its fallback. */
  maxTagBytes: 4096,
  maxTitleChars: 120,
  maxBodyChars: 4000,
  maxOptions: 8,
  maxLabelChars: 200,
  maxIdChars: 40,
} as const;

export interface DecisionCardOption {
  /** Stable per-card identity for the option ("0", "1", … when omitted). */
  id: string;
  label: string;
  recommended?: boolean;
}

export interface DecisionCard {
  title: string;
  body?: string;
  options: DecisionCardOption[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxChars) {
    return null;
  }
  return trimmed;
}

/**
 * Parse the card tag off a signed event's tags. Returns null for: no card
 * tag, non-JSON payloads, wrong version, or any shape outside the bounds —
 * the caller then renders the message's fallback content as plain markdown.
 *
 * Leniency is deliberate and narrow: if an author marks MORE than one option
 * recommended, only the first marker survives (the card still renders and
 * still one-taps; the strict authoring path in `buildCardTag` refuses the
 * send before it can ever hit the wire).
 */
export function parseCardTags(tags: string[][]): DecisionCard | null {
  const raw = tags.find((tag) => tag[0] === "card" && tag.length >= 2);
  if (!raw) {
    return null;
  }
  const payload = raw[1];
  if (
    typeof payload !== "string" ||
    payload.length === 0 ||
    payload.length > CARD_LIMITS.maxTagBytes
  ) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed) || parsed.v !== 1) {
    return null;
  }
  const title = boundedString(parsed.title, CARD_LIMITS.maxTitleChars);
  if (!title) {
    return null;
  }
  const body =
    parsed.body === undefined
      ? undefined
      : (boundedString(parsed.body, CARD_LIMITS.maxBodyChars) ?? undefined);
  // `body: ""` and whitespace-only bodies degrade to "no body" rather than
  // rejecting the card — the title and options carry the question.
  if (!Array.isArray(parsed.options)) {
    return null;
  }
  const optionCount = parsed.options.length;
  if (optionCount < 2 || optionCount > CARD_LIMITS.maxOptions) {
    return null;
  }
  let recommendedSeen = false;
  const options: DecisionCardOption[] = [];
  for (let index = 0; index < optionCount; index += 1) {
    const candidate = parsed.options[index];
    if (!isPlainObject(candidate)) {
      return null;
    }
    const label = boundedString(candidate.label, CARD_LIMITS.maxLabelChars);
    if (!label) {
      return null;
    }
    const explicitId =
      candidate.id === undefined
        ? null
        : boundedString(candidate.id, CARD_LIMITS.maxIdChars);
    const option: DecisionCardOption = {
      id: explicitId ?? String(index),
      label,
    };
    if (candidate.recommended === true && !recommendedSeen) {
      option.recommended = true;
      recommendedSeen = true;
    }
    options.push(option);
  }
  return body ? { title, body, options } : { title, options };
}

/**
 * Authoring-side counterpart: validate strictly and build the wire tag. This
 * is the seam the CLI `--card` flag and any future composer builder call —
 * it REFUSES shapes the parse tolerates (more than one recommended option),
 * so the leniency above stays a rendering guard, never a way to publish a
 * self-contradicting card.
 */
export function buildCardTag(card: DecisionCard): {
  tag: string[][];
  fallbackContent: string;
} {
  const title = boundedString(card.title, CARD_LIMITS.maxTitleChars);
  if (!title) {
    throw new Error("card title must be 1-120 characters");
  }
  let body: string | undefined;
  if (card.body !== undefined && card.body.trim().length > 0) {
    const bounded = boundedString(card.body, CARD_LIMITS.maxBodyChars);
    if (bounded === null) {
      throw new Error("card body must be at most 4000 characters");
    }
    body = bounded;
  }
  if (
    !Array.isArray(card.options) ||
    card.options.length < 2 ||
    card.options.length > CARD_LIMITS.maxOptions
  ) {
    throw new Error("card needs 2-8 options");
  }
  const recommended = card.options.filter((o) => o.recommended === true);
  if (recommended.length > 1) {
    throw new Error(
      `at most one option may be recommended (${recommended.length} marked)`,
    );
  }
  const options = card.options.map((option, index) => {
    const label = boundedString(option.label, CARD_LIMITS.maxLabelChars);
    if (!label) {
      throw new Error(`option ${index + 1} label must be 1-200 characters`);
    }
    const entry: Record<string, unknown> = { label };
    const id =
      option.id === undefined
        ? null
        : boundedString(option.id, CARD_LIMITS.maxIdChars);
    if (id) {
      entry.id = id;
    }
    if (option.recommended === true) {
      entry.recommended = true;
    }
    return entry;
  });
  const payload: Record<string, unknown> = { v: 1, title, options };
  if (body) {
    payload.body = body;
  }
  const tag = ["card", JSON.stringify(payload)];
  if (tag[1].length > CARD_LIMITS.maxTagBytes) {
    throw new Error(
      `card payload exceeds ${CARD_LIMITS.maxTagBytes} bytes after serialization`,
    );
  }
  return {
    tag: [tag],
    fallbackContent: cardFallbackText({ title, body, options: card.options }),
  };
}

/**
 * The human-readable content a card event carries alongside the tag. Every
 * plain client renders exactly this — the desktop app today, any nostr
 * reader forever — so it must read as a complete question on its own, with
 * the recommendation visible, not as a corrupted fragment of the card.
 */
export function cardFallbackText(card: DecisionCard): string {
  const lines: string[] = [`**${card.title.trim()}**`];
  const body = card.body?.trim();
  if (body) {
    lines.push("", body);
  }
  lines.push("");
  for (const option of card.options) {
    lines.push(
      `- ${option.label.trim()}${option.recommended === true ? " *(Recommended)*" : ""}`,
    );
  }
  lines.push("", "_Reply with an option or your own answer._");
  return lines.join("\n");
}
