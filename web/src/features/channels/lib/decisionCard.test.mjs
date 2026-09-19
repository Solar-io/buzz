import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCardTag,
  cardFallbackText,
  parseCardTags,
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

function tagFor(payload) {
  return [["card", JSON.stringify(payload)]];
}

test("parses a well-formed card tag", () => {
  const card = parseCardTags(tagFor(VALID));
  assert.equal(card.title, "Ship the claims fix?");
  assert.equal(card.body, "Second bounce needed.");
  assert.equal(card.options.length, 2);
  assert.equal(card.options[0].id, "now");
  // Absent id derives positionally.
  assert.equal(card.options[1].id, "1");
  assert.equal(card.options[1].recommended, true);
  assert.equal(card.options[0].recommended, undefined);
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
  assert.equal(parseCardTags(tagFor({ ...VALID, v: 2 })), null);
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

test("oversized tag json degrades to null", () => {
  // The reachable fat-tag path: every field is individually legal (4000-char
  // body, 8 max-length labels) but the serialized tag crosses the cap —
  // this is exactly the authoring mistake the tag cap exists to catch.
  const fat = {
    v: 1,
    title: "Q",
    body: "b".repeat(4000),
    options: Array.from({ length: 8 }, () => ({
      label: "y".repeat(200),
    })),
  };
  const wire = JSON.stringify(fat);
  assert.ok(
    wire.length > CARD_LIMITS.maxTagBytes,
    `fixture must actually exceed the cap (got ${wire.length})`,
  );
  assert.equal(parseCardTags([["card", wire]]), null);
  // And the authoring side refuses the same card before it can be sent.
  assert.throws(
    () =>
      buildCardTag({
        title: fat.title,
        body: fat.body,
        options: fat.options,
      }),
    /exceeds 4096/,
  );
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
  assert.equal(card.options[0].recommended, true);
  assert.equal(card.options[1].recommended, undefined);
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
  assert.equal(parsed.options[1].recommended, true);
  // Wire payload omits ids the author did not supply.
  const wire = JSON.parse(tag[0][1]);
  assert.ok(wire.options.every((o) => !("id" in o)));
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
});

test("cardFallbackText reads as a complete question in a plain client", () => {
  const text = cardFallbackText({
    title: "Ship the claims fix?",
    body: "Second bounce needed.",
    options: [
      { id: "0", label: "Relaunch now" },
      { id: "1", label: "Let it ride", recommended: true },
    ],
  });
  assert.equal(
    text,
    "**Ship the claims fix?**\n\nSecond bounce needed.\n\n- Relaunch now\n- Let it ride *(Recommended)*\n\n_Reply with an option or your own answer._",
  );
});

test("cardFallbackText without body keeps the same shape", () => {
  const text = cardFallbackText({
    title: "Q",
    options: [
      { id: "0", label: "A" },
      { id: "1", label: "B" },
    ],
  });
  assert.equal(
    text,
    "**Q**\n\n- A\n- B\n\n_Reply with an option or your own answer._",
  );
});
