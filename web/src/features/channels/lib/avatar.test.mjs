import assert from "node:assert/strict";
import { test } from "node:test";
import { AVATAR_PALETTE, avatarPaletteClass, getInitials } from "./avatar.ts";

test("getInitials takes the first letter of each of the first two words", () => {
  assert.equal(getInitials("Sam Gallant"), "SG");
  assert.equal(getInitials("ada lovelace turing"), "AL");
  assert.equal(getInitials("Prince"), "P");
});

test("getInitials strips punctuation instead of showing it", () => {
  // The old `label.slice(0, 2)` rendered "@a" and "np" here.
  assert.equal(getInitials("@alice"), "A");
  assert.equal(getInitials("npub1xyz"), "N");
  assert.equal(getInitials("jean-luc picard"), "JL");
});

test("getInitials survives a name with no letters at all", () => {
  assert.equal(getInitials("!!!"), "");
  assert.equal(getInitials(""), "");
});

test("the palette has exactly the desktop's seven classes", () => {
  assert.equal(AVATAR_PALETTE.length, 7);
  assert.deepEqual(new Set(AVATAR_PALETTE).size, 7);
  for (const entry of AVATAR_PALETTE) {
    assert.match(entry, /^bg-\S+ text-\S+$/);
  }
});

test("avatarPaletteClass is stable and case-insensitive per name", () => {
  assert.equal(avatarPaletteClass("Sam Gallant"), avatarPaletteClass("Sam Gallant"));
  assert.equal(avatarPaletteClass("Sam Gallant"), avatarPaletteClass(" sam gallant "));
});

test("avatarPaletteClass always returns a palette member", () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const chosen = avatarPaletteClass(`user-${i}`);
    assert.ok(AVATAR_PALETTE.includes(chosen), chosen);
    seen.add(chosen);
  }
  // A hash that collapsed to one bucket would still pass the check above.
  assert.equal(seen.size, 7);
});

test("avatarPaletteClass separates two specific names", () => {
  // Hardcoded, not derived from the function: "Alice" and "Bob" land on
  // different palette entries under the desktop's hash.
  assert.equal(avatarPaletteClass("Alice"), "bg-orange-500 text-white");
  assert.equal(avatarPaletteClass("Bob"), "bg-cyan-400 text-cyan-950");
});
