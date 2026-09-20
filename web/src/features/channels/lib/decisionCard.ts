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
 * ## Two wire versions, ONE parsed shape
 *
 * v1 (shipped 9/16) is a single question:
 *
 *   {"v":1,"title":string,"body"?:string,
 *    "options":[{"id"?:string,"label":string,"recommended"?:boolean}]}
 *
 * v2 is an interview — up to `maxQuestions` questions answered in sequence:
 *
 *   {"v":2,"title"?:string,"body"?:string,
 *    "questions":[{"id"?:string,"header"?:string,"question":string,
 *                  "body"?:string,"multiSelect"?:boolean,
 *                  "options":[{"id"?,"label","description"?,"recommended"?}]}]}
 *
 * `parseCardTags` NORMALIZES both into one shape: a v1 card is an interview
 * with exactly one question whose text is the card title. There is therefore
 * one parser, one bounds validator, one Rust mirror
 * (`crates/buzz-cli/src/commands/card.rs`) and one renderer — a v2 payload
 * is never a second code path. The shared fixture corpus under
 * `test-fixtures/decision-cards/` is executed by BOTH `pnpm test` and
 * `cargo test -p buzz-cli`, so TS/Rust drift is a failing test rather than a
 * comment asking people to be careful.
 *
 * Field names deliberately mirror Claude Code's `AskUserQuestion` tool
 * schema (`question`, `header`, `options`, `label`, `description`,
 * `multiSelect`) so an agent that knows one knows the other.
 *
 * ## Resolved ids are UNIQUE, and that is a contract not a preference
 *
 * Ids are filled positionally when the author omits them (`"0"`, `"1"`, …)
 * and taken verbatim when supplied, so question 0 declaring `id:"1"` collides
 * with question 1's positional id. The ANSWER format (`cardAnswerTag.ts`)
 * keys on those ids: two questions called `"1"` produce two `{"q":"1"}`
 * entries that no reader can tell apart. A card like that is not a card that
 * renders imperfectly — it is a card whose structured answer is undefined.
 *
 * So both sides refuse it, at the same layer: after positional fill, any two
 * questions or any two options WITHIN one question that resolve to the same
 * id make `parseCardTags` return null and `buildCardTag` throw. The parse
 * degrading to the fallback text is the correct outcome — the text keys on
 * question TEXT in author order and stays unambiguous — and refusing at the
 * builder means the shape never reaches the wire in the first place.
 *
 * This is the one place v2 tightened a rule v1 also lives under: a v1 card
 * whose explicit option id collides with a later positional one now degrades
 * to plain text too. Deliberate — the rule is a property of the ID SCHEME,
 * which both versions share, and a version-dependent uniqueness rule would be
 * a second contract to keep in step for no gain.
 */

/**
 * Hard bounds — the parse rejects anything outside them. Every value here is
 * mirrored by `test-fixtures/decision-cards/limits.json`, which both this
 * module's fixture test and the Rust builder's test assert against. Change a
 * number in one place and exactly one suite goes red.
 */
export const CARD_LIMITS = {
  /** Card tag JSON, in UTF-16 units — client-side self-cap (Richard 9/16:
   * the relay has no generic per-tag bound, so the authoring side owns
   * this). Raised 4096 → 16384 for v2: six questions of eight described
   * options do not fit in 4 KB. Still tiny against the kind 9 content cap
   * (61,440) so a card can never crowd out its fallback. */
  maxTagBytes: 16384,
  /** Interview title. */
  maxTitleChars: 120,
  /** Interview-level body (context for every question). */
  maxBodyChars: 4000,
  /** Questions per card (v2). */
  maxQuestions: 6,
  /** One question's text. */
  maxQuestionChars: 300,
  /** One question's own body. */
  maxQuestionBodyChars: 1000,
  /** Progress-chip label. Matches Claude Code's `header` bound. */
  maxHeaderChars: 12,
  /** Options PER QUESTION. */
  maxOptions: 8,
  maxLabelChars: 200,
  /** One option's supporting line. */
  maxDescriptionChars: 200,
  maxIdChars: 40,
} as const;

export interface DecisionCardOption {
  /** Stable per-question identity for the option ("0", "1", … when omitted). */
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface CardQuestion {
  /** Always populated — explicit when the author supplied one, else positional. */
  id: string;
  /** Short progress-chip label. UI only; never appears in the fallback text. */
  header?: string;
  /** The question itself. A v1 card's question is its title. */
  question: string;
  /** Question-level detail. A v1 card keeps its body at interview level. */
  body?: string;
  /** Always populated; v1 is always false. */
  multiSelect: boolean;
  options: DecisionCardOption[];
}

export interface DecisionCard {
  /**
   * Source wire version. Read by `serializeCardPayload` (which must re-emit
   * the version it was given) and available for telemetry — never branched
   * on by a renderer, which sees only the normalized shape.
   */
  v: 1 | 2;
  /**
   * The interview's name. Always populated: a v2 payload may omit it, in
   * which case it is DERIVED from the first question and may therefore
   * exceed `maxTitleChars` (a question may be 300 chars). A derived title is
   * never written back to the wire — see `serializeCardPayload`.
   */
  title: string;
  body?: string;
  /** Author order, always ≥1. A v1 card has exactly one. */
  questions: CardQuestion[];
}

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The ONE trim set for a card string field: Unicode `White_Space` ∪ U+FEFF.
 *
 * Neither language's built-in trim is that set, and the two disagree in BOTH
 * directions: `String.prototype.trim` strips U+FEFF and leaves U+0085 (NEL),
 * while Rust's `str::trim` (Unicode `White_Space`) strips U+0085 and leaves
 * U+FEFF. Every card field is trimmed on both sides, so calling either
 * built-in makes the two validators disagree about what the field even IS —
 * a `{"label":"\uFEFF"}` the CLI accepted became a card the web parser
 * returned null for, i.e. a published card that degrades to plain text.
 *
 * The mirror is `CARD_TRIM_CHARS` in `crates/buzz-cli/src/commands/card.rs`:
 * the same code points in the same order. Do not call `.trim()` on a card
 * field — use `cardTrim`.
 */
const CARD_TRIM_CHARS =
  // Unicode White_Space …
  "\u0009\u000A\u000B\u000C\u000D\u0020\u0085\u00A0\u1680" +
  "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A" +
  "\u2028\u2029\u202F\u205F\u3000" +
  // … ∪ U+FEFF (ZERO WIDTH NO-BREAK SPACE / BOM), which is NOT White_Space.
  "\uFEFF";

const CARD_TRIM_SET = new Set(CARD_TRIM_CHARS.split(""));

/**
 * `String.prototype.trim` over `CARD_TRIM_CHARS` instead of ECMAScript's set.
 *
 * Exported because the ANSWER format (`cardAnswerTag.ts`) bounds its own
 * string fields and must agree with this module about what an empty field
 * IS — a second trim there would be a third trim set to keep in step with
 * Rust, which is the exact drift this function exists to close.
 */
export function cardTrim(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && CARD_TRIM_SET.has(value[start])) {
    start += 1;
  }
  while (end > start && CARD_TRIM_SET.has(value[end - 1])) {
    end -= 1;
  }
  return value.slice(start, end);
}

/**
 * A lone half of a surrogate pair — text that is not valid UTF-8 and cannot
 * be made valid. `JSON.stringify` does not fail on one (well-formed
 * stringify escapes it, ES2019), so the tag LOOKS fine while `serde_json`
 * refuses to decode `"\ud800"` at all: the CLI cannot read back a card this
 * builder used to emit happily. Both sides refuse a payload carrying one.
 *
 * Deliberately NOT extended to display-hostile-but-legal characters (RTL
 * overrides U+202E, ZWJ U+200D, combining marks): those are author text and
 * ride the wire verbatim. The answer to them is bidi isolation where a label
 * is RENDERED — a UI-phase job, not a wire-format one.
 */
function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      // NaN (past the end) fails both comparisons: a trailing high surrogate
      // is unpaired.
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/**
 * Any string anywhere in a payload. Iterative on purpose: a card payload may
 * legally be 16 KB of JSON, and a recursive walk over a deeply nested one
 * would trade the parser's null return for a stack overflow — the parse must
 * stay total.
 */
export function containsUnpairedSurrogate(value: unknown): boolean {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      if (hasUnpairedSurrogate(current)) {
        return true;
      }
    } else if (Array.isArray(current)) {
      for (const entry of current) {
        pending.push(entry);
      }
    } else if (isPlainObject(current)) {
      for (const entry of Object.values(current)) {
        pending.push(entry);
      }
    }
  }
  return false;
}

function boundedString(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = cardTrim(value);
  if (trimmed.length === 0 || trimmed.length > maxChars) {
    return null;
  }
  return trimmed;
}

/**
 * A body field: absent, blank and OVER-LENGTH all degrade to "no body"
 * rather than rejecting the card. This is v1's shipped behaviour
 * (`parsed.body === undefined ? undefined : bounded ?? undefined`) and it is
 * kept deliberately — the title/question and options carry the ask, so a fat
 * body is a reason to drop the body, not the card. The AUTHORING side is
 * strict about the same field; leniency only ever runs render-side.
 */
function lenientBody(value: unknown, maxChars: number): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return boundedString(value, maxChars) ?? undefined;
}

/**
 * `allowDescription` is the v1 promise, not a convenience. v1 has no
 * per-option `description`, so a v1 card carrying that key must render
 * exactly as it did before v2 existed — an unknown key on a v1 wire payload
 * can never be a reason to reject the card. v2 validates the same field
 * strictly, because there it is part of the format.
 */
function parseOptions(
  raw: unknown,
  allowDescription: boolean,
): DecisionCardOption[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  if (raw.length < 2 || raw.length > CARD_LIMITS.maxOptions) {
    return null;
  }
  let recommendedSeen = false;
  // Resolved ids, so an explicit `"1"` and a later positional `"1"` collide
  // here exactly as they would in an answer payload. See the module doc.
  const seenIds = new Set<string>();
  const options: DecisionCardOption[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const candidate: unknown = raw[index];
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
    const id = explicitId ?? String(index);
    if (seenIds.has(id)) {
      return null;
    }
    seenIds.add(id);
    const option: DecisionCardOption = { id, label };
    if (allowDescription && candidate.description !== undefined) {
      const description = boundedString(
        candidate.description,
        CARD_LIMITS.maxDescriptionChars,
      );
      if (!description) {
        return null;
      }
      option.description = description;
    }
    if (candidate.recommended === true && !recommendedSeen) {
      option.recommended = true;
      recommendedSeen = true;
    }
    options.push(option);
  }
  return options;
}

/** v1 → one question carrying the card's title, body stays interview-level. */
function parseV1(parsed: Record<string, unknown>): DecisionCard | null {
  const title = boundedString(parsed.title, CARD_LIMITS.maxTitleChars);
  if (!title) {
    return null;
  }
  const body = lenientBody(parsed.body, CARD_LIMITS.maxBodyChars);
  const options = parseOptions(parsed.options, false);
  if (!options) {
    return null;
  }
  const question: CardQuestion = {
    id: "0",
    question: title,
    multiSelect: false,
    options,
  };
  const card: DecisionCard = { v: 1, title, questions: [question] };
  if (body) {
    card.body = body;
  }
  return card;
}

function parseV2(parsed: Record<string, unknown>): DecisionCard | null {
  const rawQuestions = parsed.questions;
  if (!Array.isArray(rawQuestions)) {
    return null;
  }
  if (
    rawQuestions.length < 1 ||
    rawQuestions.length > CARD_LIMITS.maxQuestions
  ) {
    return null;
  }
  const questions: CardQuestion[] = [];
  // Same rule as the option ids one level down, for the same reason: the
  // answer payload keys on these. See the module doc.
  const seenIds = new Set<string>();
  for (let index = 0; index < rawQuestions.length; index += 1) {
    const candidate: unknown = rawQuestions[index];
    if (!isPlainObject(candidate)) {
      return null;
    }
    const text = boundedString(
      candidate.question,
      CARD_LIMITS.maxQuestionChars,
    );
    if (!text) {
      return null;
    }
    const options = parseOptions(candidate.options, true);
    if (!options) {
      return null;
    }
    const explicitId =
      candidate.id === undefined
        ? null
        : boundedString(candidate.id, CARD_LIMITS.maxIdChars);
    const id = explicitId ?? String(index);
    if (seenIds.has(id)) {
      return null;
    }
    seenIds.add(id);
    const question: CardQuestion = {
      id,
      question: text,
      multiSelect: candidate.multiSelect === true,
      options,
    };
    if (candidate.header !== undefined) {
      const header = boundedString(
        candidate.header,
        CARD_LIMITS.maxHeaderChars,
      );
      if (!header) {
        return null;
      }
      question.header = header;
    }
    const body = lenientBody(candidate.body, CARD_LIMITS.maxQuestionBodyChars);
    if (body) {
      question.body = body;
    }
    questions.push(question);
  }
  // The interview title is optional on the wire; an absent one is the first
  // question's text, so `card.title` is never empty for a renderer. The
  // authoring side requires an explicit title once there is more than one
  // question (a two-question interview named after question one reads as a
  // mistake), so this derivation is only ever reached for a single question.
  let title: string;
  if (parsed.title === undefined) {
    title = questions[0].question;
  } else {
    const explicit = boundedString(parsed.title, CARD_LIMITS.maxTitleChars);
    if (!explicit) {
      return null;
    }
    title = explicit;
  }
  const body = lenientBody(parsed.body, CARD_LIMITS.maxBodyChars);
  const card: DecisionCard = { v: 2, title, questions };
  if (body) {
    card.body = body;
  }
  return card;
}

/**
 * Parse the card tag off a signed event's tags. Returns null for: no card
 * tag, non-JSON payloads, an unknown or missing version, or any shape
 * outside the bounds — the caller then renders the message's fallback
 * content as plain markdown. Total by construction: every malformed shape
 * returns null, nothing throws.
 *
 * Leniency is deliberate and narrow: if an author marks MORE than one option
 * recommended within one question, only the first marker survives (the card
 * still renders and still one-taps; the strict authoring path in
 * `buildCardTag` refuses the send before it can ever hit the wire). An
 * over-long body degrades to no body for the same reason.
 */
export function parseCardTags(tags: string[][]): DecisionCard | null {
  // `tag?.[0]` rather than `tag[0]`: the doc comment above promises nothing
  // throws, and a tags array carrying a null element (a hand-built event, a
  // decoder that admits one) would otherwise throw here rather than return
  // null. Nothing on the card path can reach it today — messageBuffer.ts
  // throws on the same input first — but the promise is this module's, so
  // the guard is this module's too.
  const raw = tags.find((tag) => tag?.[0] === "card" && tag.length >= 2);
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
  if (!isPlainObject(parsed)) {
    return null;
  }
  // Not valid UTF-8 and unreadable by the Rust side, so it is not a card
  // here either — the builder refuses the same payload, which keeps
  // serialize → parse honest rather than adding a fourth asymmetry.
  if (containsUnpairedSurrogate(parsed)) {
    return null;
  }
  // Strict equality on a number: `v: "2"`, `v: 3` and a missing `v` are all
  // unknown versions and all degrade to the fallback text. JSON has ONE
  // number type, so this also accepts `1.0` and `1e0` — nothing here can
  // tell them apart from `1`, and the Rust builder matches that by value
  // rather than by serde's storage type.
  if (parsed.v === 1) {
    return parseV1(parsed);
  }
  if (parsed.v === 2) {
    return parseV2(parsed);
  }
  return null;
}

/**
 * Re-serialize an ALREADY-NORMALIZED card back to its wire payload — the
 * inverse of `parseCardTags`, pinned by a round-trip test:
 *
 *   parseCardTags([["card", serializeCardPayload(c)]])  deep-equals  c
 *
 * The asks cache needs this: it stores the raw payload JSON so a reload
 * re-validates through the CURRENT parser, and `JSON.stringify({v:1,...card})`
 * only worked while `DecisionCard` WAS the payload minus its version. It is
 * not the same function as `buildCardTag`, whose input is untrusted author
 * JSON and which omits ids the author never supplied.
 */
export function serializeCardPayload(card: DecisionCard): string {
  if (card.v === 1) {
    if (card.questions.length !== 1) {
      throw new Error("a v1 card must carry exactly one question");
    }
    const payload: Record<string, unknown> = { v: 1, title: card.title };
    if (card.body) {
      payload.body = card.body;
    }
    payload.options = card.questions[0].options.map(serializeOption);
    return JSON.stringify(payload);
  }
  const payload: Record<string, unknown> = { v: 2 };
  // A title equal to the first question's text is exactly what the parser
  // derives for a title-less payload, so omitting it here round-trips and
  // keeps a derived title (which may exceed maxTitleChars) off the wire.
  if (card.title !== card.questions[0]?.question) {
    payload.title = card.title;
  }
  if (card.body) {
    payload.body = card.body;
  }
  payload.questions = card.questions.map((question) => {
    const entry: Record<string, unknown> = { id: question.id };
    if (question.header) {
      entry.header = question.header;
    }
    entry.question = question.question;
    if (question.body) {
      entry.body = question.body;
    }
    if (question.multiSelect) {
      entry.multiSelect = true;
    }
    entry.options = question.options.map(serializeOption);
    return entry;
  });
  return JSON.stringify(payload);
}

function serializeOption(option: DecisionCardOption): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    id: option.id,
    label: option.label,
  };
  if (option.description) {
    entry.description = option.description;
  }
  if (option.recommended === true) {
    entry.recommended = true;
  }
  return entry;
}

/** Authoring-side failure. Message text is mirrored by the Rust builder. */
function reject(message: string): never {
  throw new Error(message);
}

function requireBounded(
  value: unknown,
  maxChars: number,
  message: string,
): string {
  const bounded = boundedString(value, maxChars);
  if (bounded === null) {
    reject(message);
  }
  return bounded;
}

/**
 * A body on the AUTHORING side: absent or blank is fine, over-length is a
 * refusal. The parse degrades the same field instead — leniency runs
 * render-side only, so an author never silently ships a truncated card.
 */
function strictBody(
  value: unknown,
  maxChars: number,
  message: string,
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    reject(message);
  }
  const trimmed = cardTrim(value);
  if (trimmed.length === 0) {
    return undefined;
  }
  if (trimmed.length > maxChars) {
    reject(message);
  }
  return trimmed;
}

/**
 * `allowDescription` mirrors the parse: v1 has no per-option `description`,
 * so the builder DROPS the key from canonical v1 output instead of refusing
 * the send. Refusing would make the builder stricter than the v1 format it
 * is emitting; dropping keeps the canonical payload a valid v1 card and
 * keeps the fallback text identical to what v1 has shipped since 9/16.
 */
function buildOptions(
  raw: unknown,
  prefix: string,
  allowDescription: boolean,
): Record<string, unknown>[] {
  if (!Array.isArray(raw)) {
    reject(`${prefix}options must be an array`);
  }
  if (raw.length < 2 || raw.length > CARD_LIMITS.maxOptions) {
    reject(
      `${prefix}needs 2-${CARD_LIMITS.maxOptions} options (got ${raw.length})`,
    );
  }
  let recommendedCount = 0;
  // Resolved id → the 1-based position that claimed it, so the refusal can
  // name BOTH colliding options rather than only the second one.
  const idOwner = new Map<string, number>();
  const options: Record<string, unknown>[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const candidate: unknown = raw[index];
    if (!isPlainObject(candidate)) {
      reject(`${prefix}option ${index + 1} must be an object`);
    }
    const label = requireBounded(
      candidate.label,
      CARD_LIMITS.maxLabelChars,
      `${prefix}option ${index + 1} label must be 1-${CARD_LIMITS.maxLabelChars} characters`,
    );
    // Mirror of the Rust builder: an explicit bounded id rides the wire, an
    // absent one is omitted entirely (the parse derives positional ids — ids
    // are render keys, not identity promises).
    const entry: Record<string, unknown> = {};
    if (candidate.id !== undefined) {
      if (typeof candidate.id !== "string") {
        reject(`${prefix}option ${index + 1} id must be a string`);
      }
      const id = cardTrim(candidate.id);
      if (id.length > CARD_LIMITS.maxIdChars) {
        reject(
          `${prefix}option ${index + 1} id must be at most ${CARD_LIMITS.maxIdChars} characters`,
        );
      }
      if (id.length > 0) {
        entry.id = id;
      }
    }
    // The id the PARSER will resolve for this option — an omitted or blank
    // explicit id is not written to the wire and becomes the position.
    const resolvedId = typeof entry.id === "string" ? entry.id : String(index);
    const owner = idOwner.get(resolvedId);
    if (owner !== undefined) {
      reject(
        `${prefix}options ${owner} and ${index + 1} resolve to the same id ${JSON.stringify(resolvedId)}`,
      );
    }
    idOwner.set(resolvedId, index + 1);
    entry.label = label;
    if (allowDescription && candidate.description !== undefined) {
      entry.description = requireBounded(
        candidate.description,
        CARD_LIMITS.maxDescriptionChars,
        `${prefix}option ${index + 1} description must be 1-${CARD_LIMITS.maxDescriptionChars} characters`,
      );
    }
    if (candidate.recommended === true) {
      recommendedCount += 1;
      entry.recommended = true;
    }
    options.push(entry);
  }
  if (recommendedCount > 1) {
    reject(
      `${prefix}at most one option may be recommended (${recommendedCount} marked)`,
    );
  }
  return options;
}

/**
 * Authoring-side counterpart to the parse: validate an untrusted author
 * payload strictly and build both halves of the outgoing kind 9 — the
 * `["card", …]` tag and the human-readable fallback content.
 *
 * This is the seam the CLI `--card` flag mirrors
 * (`crates/buzz-cli/src/commands/card.rs`) and it REFUSES shapes the parse
 * tolerates (two recommended options, an over-long body), so the leniency
 * above stays a rendering guard and never a way to publish a
 * self-contradicting card. The input is the raw payload an author writes —
 * the same JSON `--card` takes — which is why `v` is optional here and
 * required by the parse: the builder always EMITS a version.
 */
export function buildCardTag(input: unknown): {
  tag: string[][];
  fallbackContent: string;
} {
  if (!isPlainObject(input)) {
    reject("payload must be a JSON object");
  }
  // Before any field validation: `JSON.stringify` will happily escape a lone
  // surrogate into the tag, and `serde_json` cannot decode the result at all
  // — the CLI could not read back a card this builder emitted. The Rust
  // mirror reaches the same refusal inside its JSON decode and normalizes to
  // this same message, which is the reason the corpus pins for both.
  if (containsUnpairedSurrogate(input)) {
    reject("payload must not contain unpaired surrogates");
  }
  const version = resolveAuthoredVersion(input);
  const payload = version === 1 ? buildV1Payload(input) : buildV2Payload(input);
  const json = JSON.stringify(payload);
  if (json.length > CARD_LIMITS.maxTagBytes) {
    reject(
      `payload exceeds ${CARD_LIMITS.maxTagBytes} characters after serialization`,
    );
  }
  const tag = [["card", json]];
  // Generate the fallback from the card as the PARSER sees it, not from the
  // author's input: the text a plain client reads is then provably the text
  // for the card the web client renders, with no second normalization to
  // keep in step.
  const parsed = parseCardTags(tag);
  if (!parsed) {
    reject("internal: built card payload failed its own parse");
  }
  return { tag, fallbackContent: cardFallbackText(parsed) };
}

/**
 * Which version is the author writing? An explicit `v` wins. With none, a
 * `questions` key means v2 and anything else means v1 — v1 payloads in the
 * wild and in every existing `--card` invocation omit the field.
 */
function resolveAuthoredVersion(input: Record<string, unknown>): 1 | 2 {
  if (input.v === undefined) {
    return input.questions === undefined ? 1 : 2;
  }
  if (input.v === 1) {
    return 1;
  }
  if (input.v === 2) {
    return 2;
  }
  reject(`unsupported version ${JSON.stringify(input.v)} (expected 1 or 2)`);
}

function buildV1Payload(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const title = requireBounded(
    input.title,
    CARD_LIMITS.maxTitleChars,
    `title must be 1-${CARD_LIMITS.maxTitleChars} characters`,
  );
  const body = strictBody(
    input.body,
    CARD_LIMITS.maxBodyChars,
    `body must be at most ${CARD_LIMITS.maxBodyChars} characters`,
  );
  const options = buildOptions(input.options, "", false);
  const payload: Record<string, unknown> = { v: 1, title };
  if (body) {
    payload.body = body;
  }
  payload.options = options;
  return payload;
}

function buildV2Payload(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const rawQuestions = input.questions;
  if (!Array.isArray(rawQuestions)) {
    reject("questions must be an array");
  }
  if (
    rawQuestions.length < 1 ||
    rawQuestions.length > CARD_LIMITS.maxQuestions
  ) {
    reject(
      `needs 1-${CARD_LIMITS.maxQuestions} questions (got ${rawQuestions.length})`,
    );
  }
  const questions: Record<string, unknown>[] = [];
  // Same collision rule as the options one level down. See the module doc.
  const idOwner = new Map<string, number>();
  for (let index = 0; index < rawQuestions.length; index += 1) {
    const candidate: unknown = rawQuestions[index];
    const prefix = `question ${index + 1} `;
    if (!isPlainObject(candidate)) {
      reject(`question ${index + 1} must be an object`);
    }
    const text = requireBounded(
      candidate.question,
      CARD_LIMITS.maxQuestionChars,
      `${prefix}text must be 1-${CARD_LIMITS.maxQuestionChars} characters`,
    );
    const entry: Record<string, unknown> = {};
    if (candidate.id !== undefined) {
      if (typeof candidate.id !== "string") {
        reject(`${prefix}id must be a string`);
      }
      const id = cardTrim(candidate.id);
      if (id.length > CARD_LIMITS.maxIdChars) {
        reject(
          `${prefix}id must be at most ${CARD_LIMITS.maxIdChars} characters`,
        );
      }
      if (id.length > 0) {
        entry.id = id;
      }
    }
    const resolvedId = typeof entry.id === "string" ? entry.id : String(index);
    const owner = idOwner.get(resolvedId);
    if (owner !== undefined) {
      reject(
        `questions ${owner} and ${index + 1} resolve to the same id ${JSON.stringify(resolvedId)}`,
      );
    }
    idOwner.set(resolvedId, index + 1);
    if (candidate.header !== undefined) {
      entry.header = requireBounded(
        candidate.header,
        CARD_LIMITS.maxHeaderChars,
        `${prefix}header must be 1-${CARD_LIMITS.maxHeaderChars} characters`,
      );
    }
    entry.question = text;
    const body = strictBody(
      candidate.body,
      CARD_LIMITS.maxQuestionBodyChars,
      `${prefix}body must be at most ${CARD_LIMITS.maxQuestionBodyChars} characters`,
    );
    if (body) {
      entry.body = body;
    }
    if (candidate.multiSelect === true) {
      entry.multiSelect = true;
    }
    entry.options = buildOptions(candidate.options, prefix, true);
    questions.push(entry);
  }
  const payload: Record<string, unknown> = { v: 2 };
  // One question may borrow its title from the question itself; more than
  // one must be named, or the interview reads as its own first question.
  if (input.title !== undefined || questions.length > 1) {
    payload.title = requireBounded(
      input.title,
      CARD_LIMITS.maxTitleChars,
      `title must be 1-${CARD_LIMITS.maxTitleChars} characters`,
    );
  }
  const body = strictBody(
    input.body,
    CARD_LIMITS.maxBodyChars,
    `body must be at most ${CARD_LIMITS.maxBodyChars} characters`,
  );
  if (body) {
    payload.body = body;
  }
  payload.questions = questions;
  return payload;
}

/**
 * The human-readable content a card event carries alongside the tag. Every
 * plain client renders exactly this — the desktop app today, any nostr
 * reader forever — so it must read as a complete, answerable question set on
 * its own, with the recommendation visible, not as a corrupted fragment of
 * the card.
 *
 * The v1 shape is a special case of the v2 one, not a branch: a lone
 * question whose text IS the title and which carries no body and no
 * multi-select hint adds no heading of its own, which is exactly the text v1
 * has emitted since 9/16 (byte-identical, pinned by this module's tests and
 * by the Rust mirror). `header` is a progress-chip label and never appears
 * here — it has no meaning in a linear text rendering.
 */
export function cardFallbackText(card: DecisionCard): string {
  const lines: string[] = [`**${cardTrim(card.title)}**`];
  const body = card.body === undefined ? undefined : cardTrim(card.body);
  if (body) {
    lines.push("", body);
  }
  const count = card.questions.length;
  for (let index = 0; index < count; index += 1) {
    const question = card.questions[index];
    const text = cardTrim(question.question);
    const questionBody =
      question.body === undefined ? undefined : cardTrim(question.body);
    const implicit =
      count === 1 &&
      text === cardTrim(card.title) &&
      !questionBody &&
      !question.multiSelect;
    if (!implicit) {
      const number = count > 1 ? `${index + 1}. ` : "";
      const hint = question.multiSelect ? " _(choose any that apply)_" : "";
      lines.push("", `**${number}${text}**${hint}`);
      if (questionBody) {
        lines.push("", questionBody);
      }
    }
    lines.push("");
    for (const option of question.options) {
      const marker = option.recommended === true ? " *(Recommended)*" : "";
      const description =
        option.description === undefined
          ? undefined
          : cardTrim(option.description);
      const detail = description ? ` — ${description}` : "";
      lines.push(`- ${cardTrim(option.label)}${marker}${detail}`);
    }
  }
  lines.push("", "_Reply with an option or your own answer._");
  return lines.join("\n");
}
