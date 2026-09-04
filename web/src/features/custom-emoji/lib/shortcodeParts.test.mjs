import assert from "node:assert/strict";
import test from "node:test";

import { buildShortcodePattern, splitShortcodes } from "./shortcodeParts.ts";

const MAP = new Map([
  ["party", "https://relay.example/party.png"],
  ["party_parrot", "https://relay.example/parrot.gif"],
]);

test("an unknown shortcode stays literal text", () => {
  assert.deepEqual(splitShortcodes("hi :nope: there", MAP), [
    { kind: "text", value: "hi :nope: there" },
  ]);
});

test("a known shortcode becomes a resolved emoji part", () => {
  assert.deepEqual(splitShortcodes("ship :party: it", MAP), [
    { kind: "text", value: "ship " },
    {
      kind: "emoji",
      shortcode: "party",
      url: "https://relay.example/party.png",
      raw: ":party:",
    },
    { kind: "text", value: " it" },
  ]);
});

/**
 * The regex alternation is ordered longest-first for exactly this case: with
 * `party` first, `:party_parrot:` would match `:party` and leave `_parrot:`
 * behind as text.
 */
test("a longer shortcode is not shadowed by a shorter prefix", () => {
  const parts = splitShortcodes(":party_parrot:", MAP);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].kind, "emoji");
  assert.equal(parts[0].shortcode, "party_parrot");
  assert.equal(parts[0].url, "https://relay.example/parrot.gif");
});

test("matching is case-insensitive and resolves through lowercase", () => {
  const parts = splitShortcodes(":Party_Parrot:", MAP);
  assert.equal(parts[0].kind, "emoji");
  assert.equal(parts[0].shortcode, "party_parrot");
  assert.equal(parts[0].raw, ":Party_Parrot:");
});

test("several occurrences all resolve", () => {
  const kinds = splitShortcodes(":party: x :party:", MAP).map((p) => p.kind);
  assert.deepEqual(kinds, ["emoji", "text", "emoji"]);
});

test("an empty palette leaves the text untouched", () => {
  assert.deepEqual(splitShortcodes(":party:", new Map()), [
    { kind: "text", value: ":party:" },
  ]);
});

test("buildShortcodePattern returns null when there is nothing to match", () => {
  assert.equal(buildShortcodePattern([]), null);
  assert.equal(buildShortcodePattern(["  "]), null);
});

test("regex metacharacters in a shortcode are escaped, not interpreted", () => {
  // The relay would reject `a.c`, but the renderer must not depend on that:
  // unescaped, the `.` makes `:abc:` match a shortcode that is not it.
  //
  // Asserting only on `splitShortcodes(":abc:")` does NOT discriminate — the
  // defensive "matched but unresolvable" branch hands back the same literal
  // text either way. Surrounding text is what exposes the bad match: an
  // unescaped pattern splits this into three parts.
  const map = new Map([["a.c", "https://relay.example/dot.png"]]);
  assert.deepEqual(
    splitShortcodes("x:abc:y", map),
    [{ kind: "text", value: "x:abc:y" }],
    "an unrelated token must not be split apart",
  );
  assert.equal(splitShortcodes(":a.c:", map)[0].kind, "emoji");
});
