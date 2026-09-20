import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCardTag,
  cardFallbackText,
  parseCardTags,
  serializeCardPayload,
  CARD_LIMITS,
} from "./decisionCard.ts";

const VALID = {
  v: 1,
  title: "Ship the claims fix?",
  body: "Second bounce needed.",
  options: [
    { id: "now", label: "Relaunch now" },
    { label: "Let it ride", recommended: true },
  ],
};

const VALID_V2 = {
  v: 2,
  title: "Ship the claims fix",
  questions: [
    {
      id: "scope",
      header: "Scope",
      question: "Which surfaces?",
      body: "Web is the iOS bundle too.",
      multiSelect: true,
      options: [
        { id: "web", label: "Web", description: "The SPA", recommended: true },
        { label: "Desktop" },
      ],
    },
    {
      question: "When?",
      options: [{ label: "Now" }, { label: "After the release" }],
    },
  ],
};

function tagFor(payload) {
  return [["card", JSON.stringify(payload)]];
}

test("parses a well-formed card tag", () => {
  const card = parseCardTags(tagFor(VALID));
  assert.equal(card.title, "Ship the claims fix?");
  assert.equal(card.body, "Second bounce needed.");
  const options = card.questions[0].options;
  assert.equal(options.length, 2);
  assert.equal(options[0].id, "now");
  // Absent id derives positionally.
  assert.equal(options[1].id, "1");
  assert.equal(options[1].recommended, true);
  assert.equal(options[0].recommended, undefined);
});

test("a v1 card normalizes into a one-question interview", () => {
  // ONE parsed shape for both wire versions: v1 is the interview whose only
  // question is the card's title. Downstream (renderer, asks inbox, answer
  // builder) therefore never branches on the version.
  const card = parseCardTags(tagFor(VALID));
  assert.equal(card.v, 1);
  assert.equal(card.questions.length, 1);
  assert.equal(card.questions[0].question, "Ship the claims fix?");
  assert.equal(card.questions[0].id, "0");
  assert.equal(card.questions[0].multiSelect, false);
  assert.equal(card.questions[0].header, undefined);
  // The v1 body stays at interview level; the question has none of its own.
  assert.equal(card.questions[0].body, undefined);
});

test("v2 is accepted and parses into an interview in author order", () => {
  const card = parseCardTags(tagFor(VALID_V2));
  assert.equal(card.v, 2);
  assert.equal(card.title, "Ship the claims fix");
  assert.equal(card.questions.length, 2);
  assert.deepEqual(
    card.questions.map((question) => question.question),
    ["Which surfaces?", "When?"],
  );
  const first = card.questions[0];
  assert.equal(first.id, "scope");
  assert.equal(first.header, "Scope");
  assert.equal(first.body, "Web is the iOS bundle too.");
  assert.equal(first.multiSelect, true);
  assert.equal(first.options[0].description, "The SPA");
  assert.equal(first.options[0].recommended, true);
  // Absent question id derives positionally, exactly like an option id.
  assert.equal(card.questions[1].id, "1");
  assert.equal(card.questions[1].multiSelect, false);
});

test("a v2 card with no title takes the first question as its title", () => {
  const card = parseCardTags(
    tagFor({
      v: 2,
      questions: [
        {
          question: "Ship tonight?",
          options: [{ label: "Yes" }, { label: "No" }],
        },
      ],
    }),
  );
  assert.equal(card.title, "Ship tonight?");
  assert.equal(card.questions[0].question, "Ship tonight?");
});

test("v3, a string version and a missing version all degrade to null", () => {
  // The version gate is an exact numeric match, so a future v3 renders as the
  // message's fallback text rather than as a half-understood card.
  assert.equal(parseCardTags(tagFor({ ...VALID, v: 3 })), null);
  assert.equal(parseCardTags(tagFor({ ...VALID, v: "2" })), null);
  const { v, ...noVersion } = VALID;
  assert.equal(parseCardTags(tagFor(noVersion)), null);
});

test("v2 bounds: question count, header, question text and description", () => {
  const question = {
    question: "Fine?",
    options: [{ label: "A" }, { label: "B" }],
  };
  const withQuestions = (questions) =>
    parseCardTags(tagFor({ v: 2, questions }));
  assert.equal(withQuestions([]), null);
  assert.ok(withQuestions(Array.from({ length: 6 }, () => question)));
  // Seven questions — one over maxQuestions.
  assert.equal(withQuestions(Array.from({ length: 7 }, () => question)), null);
  assert.equal(withQuestions("not an array"), null);
  assert.equal(withQuestions([question, "not an object"]), null);
  assert.equal(
    withQuestions([{ ...question, question: "x".repeat(301) }]),
    null,
  );
  assert.equal(withQuestions([{ ...question, header: "thirteen char" }]), null);
  assert.equal(
    withQuestions([
      {
        question: "Fine?",
        options: [{ label: "A", description: "d".repeat(201) }, { label: "B" }],
      },
    ]),
    null,
  );
});

test("no card tag yields null (renders fallback markdown)", () => {
  assert.equal(
    parseCardTags([
      ["h", "chan"],
      ["p", "a".repeat(64)],
    ]),
    null,
  );
});

test("malformed payloads degrade to null, never a broken card", () => {
  assert.equal(parseCardTags([["card", "not json"]]), null);
  assert.equal(parseCardTags([["card", ""]]), null);
  assert.equal(parseCardTags([["card", "42"]]), null);
  // Spread order matters: the override must come AFTER ...VALID.
  assert.equal(parseCardTags(tagFor({ ...VALID, title: "" })), null);
  assert.equal(
    parseCardTags(tagFor({ ...VALID, title: "x".repeat(121) })),
    null,
  );
  assert.equal(parseCardTags(tagFor({ ...VALID, options: [] })), null);
  // 9 options — one over the cap of 8.
  const nine = Array.from({ length: 9 }, (_, i) => ({ label: `o${i}` }));
  assert.equal(parseCardTags(tagFor({ ...VALID, options: nine })), null);
  // Non-string label.
  assert.equal(
    parseCardTags(
      tagFor({ ...VALID, options: [{ label: 7 }, { label: "b" }] }),
    ),
    null,
  );
});

test("the maximal legal v1 payload fits the raised tag cap", () => {
  // At 4096 a v1 card could overflow the tag on legal fields alone; at 16384
  // it cannot. Pinned as a positive assertion so shrinking the cap back under
  // a v1 worst case is a failing test rather than a field report.
  const maximal = {
    v: 1,
    title: "t".repeat(120),
    body: "b".repeat(4000),
    options: Array.from({ length: 8 }, (_, i) => ({
      id: `${i}`.repeat(40).slice(0, 40),
      label: "y".repeat(200),
    })),
  };
  const wire = JSON.stringify(maximal);
  assert.ok(wire.length < 16384, `v1 worst case is ${wire.length} units`);
  assert.ok(parseCardTags([["card", wire]]));
});

test("oversized tag json degrades to null", () => {
  // The reachable fat-tag path under the v2 cap: every field is individually
  // legal (six questions, each with a 1000-char body and eight fully
  // described max-length options) but the serialized tag crosses 16384 —
  // this is exactly the authoring mistake the tag cap exists to catch.
  const question = {
    question: "q".repeat(300),
    body: "b".repeat(1000),
    options: Array.from({ length: 8 }, () => ({
      label: "y".repeat(200),
      description: "d".repeat(200),
    })),
  };
  const fat = {
    v: 2,
    title: "Q",
    questions: Array.from({ length: 6 }, () => question),
  };
  const wire = JSON.stringify(fat);
  assert.ok(
    wire.length > 16384,
    `fixture must actually exceed the cap (got ${wire.length})`,
  );
  assert.equal(parseCardTags([["card", wire]]), null);
  // And the authoring side refuses the same card before it can be sent.
  assert.throws(() => buildCardTag(fat), /exceeds 16384/);
});

test("two recommended options keep only the first (render-side leniency)", () => {
  const card = parseCardTags(
    tagFor({
      v: 1,
      title: "Q",
      options: [
        { label: "A", recommended: true },
        { label: "B", recommended: true },
      ],
    }),
  );
  assert.equal(card.questions[0].options[0].recommended, true);
  assert.equal(card.questions[0].options[1].recommended, undefined);
});

test("the recommended marker is per question, not per card", () => {
  const card = parseCardTags(
    tagFor({
      v: 2,
      title: "Two questions",
      questions: [
        {
          question: "First?",
          options: [{ label: "A", recommended: true }, { label: "B" }],
        },
        {
          question: "Second?",
          options: [{ label: "C", recommended: true }, { label: "D" }],
        },
      ],
    }),
  );
  assert.equal(card.questions[0].options[0].recommended, true);
  assert.equal(card.questions[1].options[0].recommended, true);
});

test("empty body degrades to no body rather than rejecting the card", () => {
  const card = parseCardTags(tagFor({ ...VALID, body: "   " }));
  assert.equal(card.body, undefined);
});

test("buildCardTag roundtrips through parseCardTags", () => {
  const { tag } = buildCardTag({
    title: " Ship tonight? ",
    options: [{ label: "Yes" }, { label: "No", recommended: true }],
  });
  const parsed = parseCardTags(tag);
  assert.equal(parsed.title, "Ship tonight?"); // trimmed
  assert.equal(parsed.questions[0].options[1].recommended, true);
  // Wire payload omits ids the author did not supply.
  const wire = JSON.parse(tag[0][1]);
  assert.ok(wire.options.every((o) => !("id" in o)));
});

test("serializeCardPayload is the inverse of parseCardTags", () => {
  // The asks cache stores the PAYLOAD, not the parsed card, so a reload
  // re-validates through the current parser. That only works while these two
  // functions are inverses — `JSON.stringify({v:1, ...card})` stopped being
  // one the moment `questions[]` replaced `options[]`.
  for (const payload of [VALID, VALID_V2]) {
    const card = parseCardTags(tagFor(payload));
    const roundTripped = parseCardTags([["card", serializeCardPayload(card)]]);
    assert.deepEqual(roundTripped, card);
  }
  // A derived title is not written back to the wire, so it round-trips as a
  // derivation rather than being frozen into the payload.
  const derived = parseCardTags(
    tagFor({
      v: 2,
      questions: [
        {
          question: "Ship tonight?",
          options: [{ label: "Yes" }, { label: "No" }],
        },
      ],
    }),
  );
  const payload = JSON.parse(serializeCardPayload(derived));
  assert.equal(payload.title, undefined);
  assert.deepEqual(parseCardTags([["card", JSON.stringify(payload)]]), derived);
});

test("buildCardTag REFUSES what the parse tolerates", () => {
  // Two recommended: render keeps the first, authoring refuses the send.
  assert.throws(
    () =>
      buildCardTag({
        title: "Q",
        options: [
          { label: "A", recommended: true },
          { label: "B", recommended: true },
        ],
      }),
    /at most one option may be recommended/,
  );
  assert.throws(
    () => buildCardTag({ title: "Q", options: [{ label: "only one" }] }),
    /2-8 options/,
  );
  assert.throws(
    () => buildCardTag({ title: "", options: VALID.options }),
    /title/,
  );
  assert.throws(
    () =>
      buildCardTag({
        title: "Q",
        body: "z".repeat(4001),
        options: VALID.options,
      }),
    /4000/,
  );
  // An interview of more than one question must be named — a two-question
  // card titled after question one reads as a mistake.
  assert.throws(
    () =>
      buildCardTag({
        v: 2,
        questions: [
          { question: "First?", options: [{ label: "A" }, { label: "B" }] },
          { question: "Second?", options: [{ label: "C" }, { label: "D" }] },
        ],
      }),
    /title must be 1-120 characters/,
  );
});

test("buildCardTag infers the version from the payload shape", () => {
  // Every shipped `--card` invocation omits `v`; a `questions` key is the
  // only thing that makes an unversioned payload a v2 one.
  const v1 = JSON.parse(
    buildCardTag({ title: "Q", options: [{ label: "A" }, { label: "B" }] })
      .tag[0][1],
  );
  assert.equal(v1.v, 1);
  const v2 = JSON.parse(
    buildCardTag({
      title: "Q",
      questions: [
        { question: "Fine?", options: [{ label: "A" }, { label: "B" }] },
      ],
    }).tag[0][1],
  );
  assert.equal(v2.v, 2);
  assert.throws(
    () => buildCardTag({ v: 3, title: "Q", options: VALID.options }),
    /unsupported version 3/,
  );
});

test("cardFallbackText reads as a complete question in a plain client", () => {
  const text = cardFallbackText({
    v: 1,
    title: "Ship the claims fix?",
    body: "Second bounce needed.",
    questions: [
      {
        id: "0",
        question: "Ship the claims fix?",
        multiSelect: false,
        options: [
          { id: "0", label: "Relaunch now" },
          { id: "1", label: "Let it ride", recommended: true },
        ],
      },
    ],
  });
  assert.equal(
    text,
    "**Ship the claims fix?**\n\nSecond bounce needed.\n\n- Relaunch now\n- Let it ride *(Recommended)*\n\n_Reply with an option or your own answer._",
  );
});

test("cardFallbackText without body keeps the same shape", () => {
  const text = cardFallbackText({
    v: 1,
    title: "Q",
    questions: [
      {
        id: "0",
        question: "Q",
        multiSelect: false,
        options: [
          { id: "0", label: "A" },
          { id: "1", label: "B" },
        ],
      },
    ],
  });
  assert.equal(
    text,
    "**Q**\n\n- A\n- B\n\n_Reply with an option or your own answer._",
  );
});

test("cardFallbackText numbers a multi-question interview", () => {
  // The only thing a plain nostr client (and the desktop app) sees, so it has
  // to carry every question, in author order, answerable as plain text.
  const card = parseCardTags(tagFor(VALID_V2));
  assert.equal(
    cardFallbackText(card),
    [
      "**Ship the claims fix**",
      "",
      "**1. Which surfaces?** _(choose any that apply)_",
      "",
      "Web is the iOS bundle too.",
      "",
      "- Web *(Recommended)* — The SPA",
      "- Desktop",
      "",
      "**2. When?**",
      "",
      "- Now",
      "- After the release",
      "",
      "_Reply with an option or your own answer._",
    ].join("\n"),
  );
});

test("CARD_LIMITS carries the v2 bounds", () => {
  assert.equal(CARD_LIMITS.maxTagBytes, 16384);
  assert.equal(CARD_LIMITS.maxQuestions, 6);
  assert.equal(CARD_LIMITS.maxHeaderChars, 12);
  assert.equal(CARD_LIMITS.maxQuestionChars, 300);
  assert.equal(CARD_LIMITS.maxDescriptionChars, 200);
});

// ---- TS/Rust contract divergences found by QA on 2026-09-20 ----

test("the trim set is Unicode White_Space + U+FEFF, not JavaScript's", () => {
  // `String.prototype.trim` strips U+FEFF and leaves U+0085 (NEL); Rust's
  // `str::trim` does exactly the opposite. Both sides now trim the union, so
  // a field that is only one of them is empty EVERYWHERE, and a field padded
  // with both fits its bound everywhere.
  for (const blank of ["﻿", "\u0085", "﻿\u0085  　"]) {
    assert.equal(
      parseCardTags(tagFor({ ...VALID, title: blank })),
      null,
      `title ${JSON.stringify(blank)}`,
    );
    assert.equal(
      parseCardTags(
        tagFor({ ...VALID, options: [{ label: blank }, { label: "B" }] }),
      ),
      null,
      `label ${JSON.stringify(blank)}`,
    );
    assert.throws(
      () => buildCardTag({ ...VALID, title: blank }),
      /title must be 1-120 characters/,
      `builder title ${JSON.stringify(blank)}`,
    );
  }
  // At the bound: 120 x's padded with one of each is 122 UTF-16 units on the
  // wire and exactly 120 after the shared trim — so the card parses AND the
  // stored title is the trimmed one.
  const padded = `﻿${"x".repeat(120)}\u0085`;
  const card = parseCardTags(tagFor({ ...VALID, title: padded }));
  assert.ok(card, "a padded title trims to the bound");
  assert.equal(card.title, "x".repeat(120));
  assert.equal(card.questions[0].question, "x".repeat(120));
  // One character more is over it, padding or not.
  assert.equal(
    parseCardTags(tagFor({ ...VALID, title: `﻿${"x".repeat(121)}\u0085` })),
    null,
  );
});

test("a v1 card IGNORES a per-option description, whatever it holds", () => {
  // v1 shipped 9/16 with no such field. A v1 card in the wild carrying the
  // key rendered then and must render now — an unknown key on a v1 payload
  // can never be a reason to reject the card.
  for (const junk of [null, 123, true, {}, "", "d".repeat(201)]) {
    const card = parseCardTags(
      tagFor({
        ...VALID,
        options: [{ label: "A", description: junk }, { label: "B" }],
      }),
    );
    assert.ok(card, `description ${JSON.stringify(junk)} must still render`);
    assert.equal(card.questions[0].options[0].description, undefined);
  }
  // A WELL-FORMED one is ignored too: v1 has one shape, not two.
  const card = parseCardTags(
    tagFor({
      ...VALID,
      options: [{ label: "A", description: "The safe one" }, { label: "B" }],
    }),
  );
  assert.ok(card);
  assert.equal(card.questions[0].options[0].description, undefined);
  assert.ok(
    !cardFallbackText(card).includes("The safe one"),
    "an ignored description never reaches the fallback text",
  );
  // The builder drops it rather than refusing the send.
  const built = buildCardTag({
    ...VALID,
    options: [{ label: "A", description: "The safe one" }, { label: "B" }],
  });
  assert.ok(!built.tag[0][1].includes("description"), built.tag[0][1]);
  // v2 still validates the same field strictly.
  assert.equal(
    parseCardTags(
      tagFor({
        ...VALID_V2,
        questions: [
          {
            question: "Which?",
            options: [
              { label: "A", description: "d".repeat(201) },
              { label: "B" },
            ],
          },
        ],
      }),
    ),
    null,
  );
});

test("an unpaired surrogate is refused by the builder and the parser", () => {
  // `JSON.stringify` escapes a lone surrogate instead of failing, so the tag
  // LOOKS fine and `serde_json` cannot decode it at all — the CLI could not
  // read back a card this builder emitted.
  for (const bad of ["\uD800", "\uDC00", "\uD800\uD800", "ok\uD800"]) {
    assert.throws(
      () =>
        buildCardTag({ ...VALID, options: [{ label: bad }, { label: "B" }] }),
      /payload must not contain unpaired surrogates/,
      JSON.stringify(bad),
    );
    assert.equal(
      parseCardTags(
        tagFor({ ...VALID, options: [{ label: bad }, { label: "B" }] }),
      ),
      null,
      JSON.stringify(bad),
    );
  }
  // A PAIRED surrogate is an astral character and rides through untouched —
  // and so do display-hostile-but-legal characters (RTL override, ZWJ), which
  // are author text and belong to the render phase.
  const card = parseCardTags(
    tagFor({
      ...VALID,
      options: [{ label: "🚀 ‮port‍" }, { label: "B" }],
    }),
  );
  assert.ok(card);
  assert.equal(card.questions[0].options[0].label, "🚀 ‮port‍");
});

test("the version is a JSON NUMBER equal to 1 or 2, not a spelling of one", () => {
  // JSON has one number type, so `1.0` and `1e0` ARE `1` here and cannot be
  // told apart without re-reading the raw text. The Rust builder matches by
  // value for the same reason — it used to match serde's storage type and
  // refused `{"v":1.0}` payloads this parser accepts.
  for (const raw of ['{"v":1.0', '{"v":1e0', '{"v":1']) {
    const card = parseCardTags([
      ["card", `${raw},"title":"Q","options":[{"label":"A"},{"label":"B"}]}`],
    ]);
    assert.ok(card, raw);
    assert.equal(card.v, 1);
  }
  assert.equal(
    parseCardTags([
      ["card", '{"v":1.5,"title":"Q","options":[{"label":"A"},{"label":"B"}]}'],
    ]),
    null,
  );
  assert.throws(
    () => buildCardTag({ ...VALID, v: 1.5 }),
    /unsupported version 1.5/,
  );
});

test("a tags array carrying a null element returns null, never a throw", () => {
  // This module's doc comment promises the parse is total. Nothing on the
  // card path reaches it today (messageBuffer.ts throws on the same input
  // first, and that is deliberately out of scope here), but the promise is
  // this module's to keep.
  assert.equal(parseCardTags([null, ["h", "chan"]]), null);
  assert.equal(parseCardTags([undefined]), null);
  const card = parseCardTags([null, ["card", JSON.stringify(VALID)]]);
  assert.ok(card, "a good card after a null element still parses");
  assert.equal(card.title, VALID.title);
});
