import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCardTags } from "./decisionCard.ts";
import {
  ANSWER_LIMITS,
  answeredQuestionCount,
  buildCardAnswerTag,
  cardAnswerFallbackText,
  isReadableCardAnswer,
  parseCardAnswerTags,
} from "./cardAnswerTag.ts";

/**
 * The answer half of the decision-card contract.
 *
 * Two things this file is deliberately built to catch, because the CARD half
 * shipped without them and adversarial QA found both (AGENTS.md, 9/20):
 *
 * 1. Hostile input from the CARD side. Option and question ids are author
 *    text echoed back into a machine payload, so "answer an id that is not on
 *    the card" and "answer a question that does not exist" have cases here
 *    rather than comments. Id COLLISIONS are now refused one layer up, by the
 *    card parser and the card builder; the cases below pin that they never
 *    reach an answer, and that a hand-built card violating the guarantee
 *    still cannot produce an ambiguous `a[]`.
 * 2. Assertions that could not fail. Every expected content string is written
 *    out in full rather than rebuilt from the builder's own pieces, every
 *    limit is hardcoded rather than restated as `ANSWER_LIMITS.x`, and the
 *    discriminating cases pick values that DIFFER (tap order vs card order,
 *    2-of-4 vs 4-of-4).
 */

const CARD_ID = "card-1";

function card(payload) {
  const parsed = parseCardTags([["card", JSON.stringify(payload)]]);
  assert.ok(parsed, "the fixture payload must parse as a card");
  return parsed;
}

/** The plan's worked example: single-select, multi-select, typed, note. */
const INTERVIEW = card({
  v: 2,
  title: "Release shape",
  questions: [
    {
      id: "scope",
      question: "Which surfaces?",
      options: [
        { id: "web", label: "Web only" },
        { id: "both", label: "Web + desktop" },
      ],
    },
    {
      id: "extras",
      question: "Which extras?",
      multiSelect: true,
      options: [
        { id: "docs", label: "Docs" },
        { id: "tests", label: "Tests" },
        { id: "perf", label: "Perf" },
      ],
    },
    {
      id: "when",
      question: "When?",
      options: [
        { id: "now", label: "Now" },
        { id: "later", label: "After the release" },
      ],
    },
  ],
});

const FOUR = card({
  v: 2,
  title: "Release shape",
  questions: [
    {
      id: "scope",
      question: "Which surfaces?",
      options: [
        { id: "web", label: "Web only" },
        { id: "both", label: "Web + desktop" },
      ],
    },
    {
      id: "extras",
      question: "Which extras?",
      multiSelect: true,
      options: [
        { id: "docs", label: "Docs" },
        { id: "tests", label: "Tests" },
      ],
    },
    {
      id: "when",
      question: "When?",
      options: [
        { id: "now", label: "Now" },
        { id: "later", label: "Later" },
      ],
    },
    {
      id: "else",
      question: "Anything else?",
      options: [
        { id: "no", label: "No" },
        { id: "yes", label: "Yes" },
      ],
    },
  ],
});

const V1 = card({
  v: 1,
  title: "Ship the claims fix?",
  options: [{ id: "now", label: "Relaunch now" }, { label: "Let it ride" }],
});

function buildOrThrow(target, draft, id = CARD_ID) {
  return buildCardAnswerTag(target, id, draft);
}

function payloadOf(built) {
  assert.equal(built.tag.length, 1);
  assert.equal(built.tag[0][0], "card-answer");
  return built.tag[0][1];
}

// ---- limits ---------------------------------------------------------------

test("ANSWER_LIMITS are the documented numbers", () => {
  // Hardcoded, never `CARD_LIMITS.x`: an expectation phrased in terms of the
  // constant it pins moves with the constant and can never fail.
  assert.deepEqual(
    { ...ANSWER_LIMITS },
    {
      maxTagBytes: 16384,
      maxAnswers: 6,
      maxOptionsPerAnswer: 8,
      maxIdChars: 40,
      maxCardIdChars: 64,
      maxTextChars: 200,
      maxNoteChars: 2000,
    },
  );
});

// ---- the wire format ------------------------------------------------------

test("a complete interview answer is one tag and one content block", () => {
  const built = buildOrThrow(INTERVIEW, {
    answers: [
      { questionId: "scope", optionIds: ["web"] },
      // Tap order is deliberately NOT card order — see the ordering test.
      { questionId: "extras", optionIds: ["tests", "docs"] },
      { questionId: "when", optionIds: [], text: "after the release" },
    ],
    note: "Also keep the CLI unchanged.",
  });

  assert.equal(
    payloadOf(built),
    '{"v":2,"c":"card-1","a":[{"q":"scope","o":["web"]},' +
      '{"q":"extras","o":["docs","tests"]},' +
      '{"q":"when","t":"after the release"}],' +
      '"n":"Also keep the CLI unchanged.","done":true}',
  );

  assert.equal(
    built.fallbackContent,
    [
      "**Which surfaces?** — Web only",
      "**Which extras?** — Docs, Tests",
      "**When?** — after the release",
      "",
      "_Note: Also keep the CLI unchanged._",
    ].join("\n"),
  );
  assert.equal(built.answer.done, true);
  assert.equal(answeredQuestionCount(built.answer), 3);
});

test("a v1 card answers structurally through the same builder", () => {
  // v1 normalizes to one question whose id is "0" and whose text is the card
  // title, so the answer names "0" and the content's bold half is the title.
  const built = buildOrThrow(V1, {
    answers: [{ questionId: "0", optionIds: ["now"] }],
  });
  assert.equal(
    payloadOf(built),
    '{"v":2,"c":"card-1","a":[{"q":"0","o":["now"]}],"done":true}',
  );
  assert.equal(
    built.fallbackContent,
    "**Ship the claims fix?** — Relaunch now",
  );
});

test("multi-select ids serialize in CARD order, not tap order", () => {
  // Discriminating on purpose: the taps are ["perf","docs"] and the card
  // order is docs < tests < perf, so a builder that preserved tap order
  // produces ["perf","docs"] and fails both assertions.
  const built = buildOrThrow(INTERVIEW, {
    answers: [{ questionId: "extras", optionIds: ["perf", "docs"] }],
  });
  assert.deepEqual(built.answer.answers[0].optionIds, ["docs", "perf"]);
  assert.ok(
    built.fallbackContent.includes("**Which extras?** — Docs, Perf"),
    built.fallbackContent,
  );
});

test("built answers round-trip through the reader exactly", () => {
  for (const draft of [
    { answers: [{ questionId: "scope", optionIds: ["both"] }] },
    {
      answers: [
        { questionId: "scope", optionIds: ["web"] },
        { questionId: "extras", optionIds: ["docs", "tests"] },
        { questionId: "when", optionIds: [], text: "tomorrow" },
      ],
      note: "with care",
    },
  ]) {
    const built = buildOrThrow(INTERVIEW, draft);
    assert.deepEqual(parseCardAnswerTags(built.tag), built.answer);
  }
});

// ---- partials -------------------------------------------------------------

test("partial answer: done is DERIVED and the content leads with the count", () => {
  const built = buildOrThrow(FOUR, {
    answers: [
      { questionId: "scope", optionIds: ["web"] },
      { questionId: "when", optionIds: ["now"] },
    ],
  });
  assert.equal(built.answer.done, false);
  assert.ok(payloadOf(built).endsWith('"done":false}'), payloadOf(built));
  assert.equal(
    built.fallbackContent,
    [
      "Answered 2 of 4 — the rest are still open.",
      "",
      "**Which surfaces?** — Web only",
      "**Which extras?** — _(not answered)_",
      "**When?** — Now",
      "**Anything else?** — _(not answered)_",
    ].join("\n"),
  );
});

test("a caller cannot assert completeness — done follows the answer count", () => {
  // The guard against the expensive failure: an agent acting on 2 of 4 as
  // though the interview concluded. `done` is not an input, so there is no
  // draft shape that can claim it. 3 of 4 is still false; 4 of 4 is true.
  const three = buildOrThrow(FOUR, {
    answers: [
      { questionId: "scope", optionIds: ["web"] },
      { questionId: "extras", optionIds: ["docs"] },
      { questionId: "when", optionIds: ["now"] },
      // deliberately no "else"
    ],
    done: true,
    // A stray `done` on the draft is simply not read.
  });
  assert.equal(three.answer.done, false);

  const all = buildOrThrow(FOUR, {
    answers: [
      { questionId: "scope", optionIds: ["web"] },
      { questionId: "extras", optionIds: ["docs"] },
      { questionId: "when", optionIds: ["now"] },
      { questionId: "else", optionIds: ["no"] },
    ],
    done: false,
  });
  assert.equal(all.answer.done, true);
  assert.ok(!all.fallbackContent.startsWith("Answered"), all.fallbackContent);
});

// ---- hostile input from the card side -------------------------------------

test("an option id that is not on the card is refused", () => {
  // The echo case: option ids are author text, so an answer naming one the
  // author never offered would hand the asking agent a pseudo-option.
  assert.throws(
    () =>
      buildOrThrow(INTERVIEW, {
        answers: [{ questionId: "scope", optionIds: ["mobile"] }],
      }),
    /has no option "mobile"/,
  );
  // Control: the same shape with a real id builds.
  assert.ok(
    buildOrThrow(INTERVIEW, {
      answers: [{ questionId: "scope", optionIds: ["web"] }],
    }),
  );
});

test("an answer naming a question the card does not have is refused", () => {
  assert.throws(
    () =>
      buildOrThrow(INTERVIEW, {
        answers: [{ questionId: "budget", optionIds: ["web"] }],
      }),
    /no question "budget"/,
  );
});

test("a card whose ids would collide is not a card, so it never gets here", () => {
  // The guard this module used to carry (`requireUniqueIds`) moved up to the
  // contract layer. Both payloads below used to PARSE into a card with
  // colliding ids, which this builder then refused at answer time — a card
  // that rendered an interview and degraded to plain text on the last tap.
  // They now fail the parse outright, so the ambiguity cannot reach an answer.
  const questionCollision = parseCardTags([
    [
      "card",
      JSON.stringify({
        v: 2,
        title: "Collide",
        questions: [
          {
            id: "1",
            question: "First?",
            options: [{ label: "a" }, { label: "b" }],
          },
          { question: "Second?", options: [{ label: "c" }, { label: "d" }] },
        ],
      }),
    ],
  ]);
  assert.equal(questionCollision, null);
  const optionCollision = parseCardTags([
    [
      "card",
      JSON.stringify({
        v: 2,
        questions: [
          {
            id: "q",
            question: "Which?",
            options: [{ id: "1", label: "a" }, { label: "b" }],
          },
        ],
      }),
    ],
  ]);
  assert.equal(optionCollision, null);
});

test("a hand-built card with colliding ids still cannot produce an ambiguous a[]", () => {
  // Defence in depth, and the reason removing `requireUniqueIds` is safe. The
  // card below never came off the wire — it is the shape the parser now
  // refuses to produce, handed straight to the builder. Whatever a caller
  // asks for, no payload carrying two `{"q":"1"}` entries (or a repeated
  // option id inside one `o`) can be emitted.
  const handBuilt = {
    v: 2,
    title: "Collide",
    questions: [
      {
        id: "1",
        question: "First?",
        multiSelect: false,
        options: [
          { id: "a", label: "a" },
          { id: "b", label: "b" },
        ],
      },
      {
        id: "1",
        question: "Second?",
        multiSelect: false,
        options: [
          { id: "c", label: "c" },
          { id: "d", label: "d" },
        ],
      },
    ],
  };
  // Two answers for the colliding id: refused by the per-submission dedupe,
  // which is what makes `a[]` unambiguous by construction.
  assert.throws(
    () =>
      buildCardAnswerTag(handBuilt, CARD_ID, {
        answers: [
          { questionId: "1", optionIds: ["c"] },
          { questionId: "1", optionIds: ["d"] },
        ],
      }),
    /two answers for question "1"/,
  );
  // One answer for it is unambiguous ON THE WIRE — one `{"q":"1"}` entry —
  // even though the card is malformed. It binds to the LAST question with
  // that id, which is why the option id has to be one of THAT question's.
  const built = buildCardAnswerTag(handBuilt, CARD_ID, {
    answers: [{ questionId: "1", optionIds: ["c"] }],
  });
  assert.equal(
    built.tag[0][1],
    '{"v":2,"c":"card-1","a":[{"q":"1","o":["c"]}],"done":false}',
  );
  assert.equal(
    built.answer.answers.filter((entry) => entry.questionId === "1").length,
    1,
  );
  // And the option-id half: a question carrying the same option id twice
  // would serialize a repeated `o` entry, which the builder's own self-parse
  // refuses rather than publishing.
  const dupOptions = {
    v: 2,
    title: "Collide",
    questions: [
      {
        id: "q",
        question: "Which?",
        multiSelect: true,
        options: [
          { id: "1", label: "a" },
          { id: "1", label: "b" },
        ],
      },
    ],
  };
  assert.throws(
    () =>
      buildCardAnswerTag(dupOptions, CARD_ID, {
        answers: [{ questionId: "q", optionIds: ["1"] }],
      }),
    /failed its own parse/,
  );
});

test("two answers for one question are refused", () => {
  assert.throws(
    () =>
      buildOrThrow(INTERVIEW, {
        answers: [
          { questionId: "scope", optionIds: ["web"] },
          { questionId: "scope", optionIds: ["both"] },
        ],
      }),
    /two answers for question "scope"/,
  );
});

test("multiSelect with nothing ticked is not an answer", () => {
  assert.throws(
    () =>
      buildOrThrow(INTERVIEW, {
        answers: [{ questionId: "extras", optionIds: [] }],
      }),
    /chose nothing and typed nothing/,
  );
  // And an empty submission is not an answer either.
  assert.throws(
    () => buildOrThrow(INTERVIEW, { answers: [] }),
    /at least one question/,
  );
});

test("a single-select question refuses two options; multiSelect accepts them", () => {
  assert.throws(
    () =>
      buildOrThrow(INTERVIEW, {
        answers: [{ questionId: "scope", optionIds: ["web", "both"] }],
      }),
    /"scope" takes one option, got 2/,
  );
  assert.ok(
    buildOrThrow(INTERVIEW, {
      answers: [{ questionId: "extras", optionIds: ["docs", "tests"] }],
    }),
  );
});

test("options and typed text are exclusive, and the same option twice is refused", () => {
  assert.throws(
    () =>
      buildOrThrow(INTERVIEW, {
        answers: [{ questionId: "scope", optionIds: ["web"], text: "or not" }],
      }),
    /both options and typed text/,
  );
  assert.throws(
    () =>
      buildOrThrow(INTERVIEW, {
        answers: [{ questionId: "extras", optionIds: ["docs", "docs"] }],
      }),
    /names option "docs" twice/,
  );
});

test("typed text and the note are bounded; the card id is bounded at 64", () => {
  const long = "x".repeat(201);
  assert.throws(
    () =>
      buildOrThrow(INTERVIEW, {
        answers: [{ questionId: "when", optionIds: [], text: long }],
      }),
    /typed answer for question "when" must be 1-200 characters/,
  );
  assert.ok(
    buildOrThrow(INTERVIEW, {
      answers: [{ questionId: "when", optionIds: [], text: "x".repeat(200) }],
    }),
  );
  assert.throws(
    () =>
      buildOrThrow(INTERVIEW, {
        answers: [{ questionId: "scope", optionIds: ["web"] }],
        note: "n".repeat(2001),
      }),
    /note must be 1-2000 characters/,
  );
  assert.throws(
    () =>
      buildOrThrow(
        INTERVIEW,
        { answers: [{ questionId: "scope", optionIds: ["web"] }] },
        "i".repeat(65),
      ),
    /card id must be 1-64 characters/,
  );
  assert.ok(
    buildOrThrow(
      INTERVIEW,
      { answers: [{ questionId: "scope", optionIds: ["web"] }] },
      "i".repeat(64),
    ),
  );
});

test("a blank note is an absent note, not a refusal", () => {
  const built = buildOrThrow(INTERVIEW, {
    answers: [{ questionId: "scope", optionIds: ["web"] }],
    note: "   ",
  });
  assert.equal(built.answer.note, undefined);
  assert.ok(!payloadOf(built).includes('"n"'), payloadOf(built));
});

test("an unpaired surrogate is refused, as it is on the card side", () => {
  // JSON.stringify escapes a lone surrogate happily; serde_json then cannot
  // decode the payload at all, so the CLI could not read back what we sent.
  assert.throws(
    () =>
      buildOrThrow(INTERVIEW, {
        answers: [{ questionId: "when", optionIds: [], text: "a\ud800b" }],
      }),
    /unpaired surrogates/,
  );
});

test("the tag cap cannot be reached by any legal card — the worst case fits", () => {
  // Honest about an equivalent mutant: 6 questions x 8 options x 40-char ids
  // plus a 2000-char note is the largest answer this format admits, and it
  // is nowhere near 16384. The cap branch therefore cannot fire from a card
  // the parser accepts. Rather than pretend otherwise, pin the headroom — if
  // a future limit change makes the worst case overflow, this fails.
  const id = (prefix, n) => `${prefix}${String(n)}`.padEnd(40, "z");
  const questions = Array.from({ length: 6 }, (_, q) => ({
    id: id("q", q),
    question: `Question ${q}`,
    multiSelect: true,
    options: Array.from({ length: 8 }, (_, o) => ({
      id: id(`o${q}_`, o),
      label: `Option ${o}`,
    })),
  }));
  const big = card({ v: 2, title: "Max", questions });
  const built = buildCardAnswerTag(big, "c".repeat(64), {
    answers: big.questions.map((question) => ({
      questionId: question.id,
      optionIds: question.options.map((option) => option.id),
    })),
    note: "n".repeat(2000),
  });
  const size = payloadOf(built).length;
  assert.ok(size < 16384, `worst-case answer payload was ${size}`);
  assert.ok(size > 4000, `worst case should be substantial, got ${size}`);
});

// ---- the content is ONE LINE PER QUESTION ---------------------------------

test("line breaks in card or typed text cannot split a question's line", () => {
  // The content contract is one line per question. Card text rides the wire
  // verbatim, so a label or question carrying a newline would silently make
  // two lines out of one and no reader could reattach them.
  const nasty = card({
    v: 2,
    title: "Nasty",
    questions: [
      {
        id: "q",
        question: "Which\nsurface?",
        options: [
          { id: "a", label: "Web\nonly" },
          { id: "b", label: "Desktop" },
        ],
      },
      {
        id: "t",
        question: "When?",
        options: [{ label: "Now" }, { label: "Later" }],
      },
    ],
  });
  const built = buildCardAnswerTag(nasty, CARD_ID, {
    answers: [
      { questionId: "q", optionIds: ["a"] },
      { questionId: "t", optionIds: [], text: "after\nthe\nrelease" },
    ],
    note: "one\ntwo",
  });
  assert.equal(
    built.fallbackContent,
    [
      "**Which surface?** — Web only",
      "**When?** — after the release",
      "",
      "_Note: one two_",
    ].join("\n"),
  );
  // The tag agrees with the content about the user's own text.
  assert.equal(built.answer.answers[1].text, "after the release");
  // Exactly one line per question, plus the blank line and the note.
  assert.equal(built.fallbackContent.split("\n").length, 4);
});

// ---- reading --------------------------------------------------------------

test("no card-answer tag reads as null — that is a COMPLETE v1 answer", () => {
  assert.equal(parseCardAnswerTags([]), null);
  assert.equal(parseCardAnswerTags([["e", "card-1", "", "reply"]]), null);
  assert.equal(parseCardAnswerTags([["card-answer"]]), null);
});

test("a present but unreadable tag is NOT absent — done:false, cardId:null", () => {
  // A COMPLETE control (done:true), so the "two tags" case below fails on
  // the duplication rather than on a partial that was never done anyway.
  const good = payloadOf(
    buildOrThrow(INTERVIEW, {
      answers: [
        { questionId: "scope", optionIds: ["web"] },
        { questionId: "extras", optionIds: ["docs"] },
        { questionId: "when", optionIds: ["now"] },
      ],
    }),
  );
  const unreadable = [
    ["not json", "not json at all"],
    ["an array payload", "[1,2,3]"],
    [
      "a future version",
      '{"v":3,"c":"card-1","a":[{"q":"0","o":["a"]}],"done":true}',
    ],
    [
      "a stringly version",
      '{"v":"2","c":"card-1","a":[{"q":"0","o":["a"]}],"done":true}',
    ],
    ["no card id", '{"v":2,"a":[{"q":"0","o":["a"]}],"done":true}'],
    ["no done flag", '{"v":2,"c":"card-1","a":[{"q":"0","o":["a"]}]}'],
    [
      "a stringly done",
      '{"v":2,"c":"card-1","a":[{"q":"0","o":["a"]}],"done":"true"}',
    ],
    ["no answers", '{"v":2,"c":"card-1","a":[],"done":false}'],
    [
      "too many answers",
      `{"v":2,"c":"card-1","a":[${Array.from({ length: 7 }, (_, i) => `{"q":"${i}","o":["a"]}`).join(",")}],"done":true}`,
    ],
    [
      "an entry with neither o nor t",
      '{"v":2,"c":"card-1","a":[{"q":"0"}],"done":true}',
    ],
    [
      "an entry with both o and t",
      '{"v":2,"c":"card-1","a":[{"q":"0","o":["a"],"t":"x"}],"done":true}',
    ],
    [
      "duplicate question ids",
      '{"v":2,"c":"card-1","a":[{"q":"0","o":["a"]},{"q":"0","o":["b"]}],"done":true}',
    ],
    [
      "a duplicated option id",
      '{"v":2,"c":"card-1","a":[{"q":"0","o":["a","a"]}],"done":true}',
    ],
    [
      "an over-long typed answer",
      `{"v":2,"c":"card-1","a":[{"q":"0","t":"${"x".repeat(201)}"}],"done":true}`,
    ],
    [
      "an over-long note",
      `{"v":2,"c":"card-1","a":[{"q":"0","o":["a"]}],"n":"${"n".repeat(2001)}","done":true}`,
    ],
    [
      "an unpaired surrogate",
      '{"v":2,"c":"card-1","a":[{"q":"0","t":"a\\ud800b"}],"done":true}',
    ],
  ];
  for (const [name, payload] of unreadable) {
    const parsed = parseCardAnswerTags([["card-answer", payload]]);
    assert.ok(
      parsed,
      `${name} must parse to the unreadable sentinel, not null`,
    );
    assert.equal(parsed.done, false, name);
    assert.equal(parsed.cardId, null, name);
    assert.equal(isReadableCardAnswer(parsed), false, name);
  }
  // Two tags: which one is the answer? Unanswerable, even though each half
  // is individually fine — the discriminating control is that ONE is read.
  const two = parseCardAnswerTags([
    ["card-answer", good],
    ["card-answer", good],
  ]);
  assert.equal(two.done, false);
  assert.equal(isReadableCardAnswer(two), false);
  assert.equal(
    parseCardAnswerTags([["card-answer", good]]).done,
    true,
    "the control payload really is readable",
  );
});

test("the tag's own card id is read but never trusted over the e-tag", () => {
  // `c` is redundant with the reply marker. A tag naming a DIFFERENT card is
  // still readable and still complete — detection keys on replyToId, so the
  // mismatch changes nothing here and must not be "helpfully" rejected.
  const parsed = parseCardAnswerTags([
    [
      "card-answer",
      '{"v":2,"c":"some-other-card","a":[{"q":"0","o":["a"]}],"done":true}',
    ],
  ]);
  assert.equal(parsed.cardId, "some-other-card");
  assert.equal(parsed.done, true);
  assert.equal(isReadableCardAnswer(parsed), true);
});

test("cardAnswerFallbackText renders a read answer the same as a built one", () => {
  const built = buildOrThrow(INTERVIEW, {
    answers: [
      { questionId: "scope", optionIds: ["both"] },
      { questionId: "extras", optionIds: ["perf"] },
    ],
  });
  const read = parseCardAnswerTags(built.tag);
  assert.equal(cardAnswerFallbackText(INTERVIEW, read), built.fallbackContent);
  assert.equal(
    built.fallbackContent,
    [
      "Answered 2 of 3 — the rest are still open.",
      "",
      "**Which surfaces?** — Web + desktop",
      "**Which extras?** — Perf",
      "**When?** — _(not answered)_",
    ].join("\n"),
  );
});
