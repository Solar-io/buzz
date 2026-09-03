import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveSnapshotCard } from "./snapshotCard.ts";
import { imetaByUrl } from "./imetaEntries.ts";

/**
 * Every classification branch of resolveSnapshotCard, ported with the
 * desktop's semantics (desktop/src/shared/ui/markdownFileCard.ts). The
 * fall-throughs matter as much as the hits: a link that cannot be verified
 * must render as a plain link, never a broken card.
 */

const URL = "https://relay.example/media/aa11";
const SHA = "ab".repeat(32); // 64 hex chars
const OTHER_SHA = "cd".repeat(32);

function entry(overrides = {}) {
  return {
    url: URL,
    m: "image/png",
    x: SHA,
    size: 2048,
    filename: "night-shift.agent.png",
    ...overrides,
  };
}

test("agent png with full imeta classifies with thumb = href", () => {
  assert.deepEqual(resolveSnapshotCard(entry(), URL, "Night Shift"), {
    displayName: "Night Shift",
    href: URL,
    filename: "night-shift.agent.png",
    size: 2048,
    sha256: SHA,
    snapshotKind: "agent",
    thumb: URL,
  });
});

test("agent json has no thumb and keeps the json suffix out of the name", () => {
  const card = resolveSnapshotCard(
    entry({ m: "application/octet-stream", filename: "night-shift.agent.json" }),
    URL,
    "Night Shift",
  );
  assert.equal(card.snapshotKind, "agent");
  assert.equal(card.thumb, undefined);
});

test("team json and team png classify as team; team png gets no thumb", () => {
  const teamJson = resolveSnapshotCard(
    entry({ filename: "ops.team.json", m: "application/octet-stream" }),
    URL,
    "Ops crew",
  );
  assert.equal(teamJson.snapshotKind, "team");
  assert.equal(teamJson.thumb, undefined);

  const teamPng = resolveSnapshotCard(
    entry({ filename: "ops.team.png" }),
    URL,
    "Ops crew",
  );
  assert.equal(teamPng.snapshotKind, "team");
  assert.equal(teamPng.thumb, undefined);
});

test("suffix match is case-insensitive", () => {
  const card = resolveSnapshotCard(
    entry({ filename: "Night-Shift.AGENT.PNG" }),
    URL,
    "Night Shift",
  );
  assert.equal(card.snapshotKind, "agent");
  assert.equal(card.thumb, URL);
});

test("child label equal to an agent filename falls back to the stem", () => {
  // The sender's label IS the filename — derive a human name from the stem.
  const card = resolveSnapshotCard(
    entry({ filename: "night_shift.agent.png" }),
    URL,
    "night_shift.agent.png",
  );
  assert.equal(card.displayName, "Night Shift");
});

test("filename extracted from the URL when imeta and label carry none", () => {
  const card = resolveSnapshotCard(
    entry({ filename: undefined }),
    `${URL}/night-shift.agent.png`,
    "   ",
  );
  assert.equal(card.filename, "night-shift.agent.png");
  assert.equal(card.displayName, "Night Shift");
});

test("empty stem derives the generic Agent name", () => {
  const card = resolveSnapshotCard(
    entry({ filename: ".agent.json", m: "application/json" }),
    URL,
    ".agent.json",
  );
  assert.equal(card.displayName, "Agent");
});

test("team filename as label returns the raw label (desktop parity quirk)", () => {
  // The label-is-filename check only recognizes .agent.(json|png), so a team
  // filename used as the label short-circuits the stem derivation and is
  // returned verbatim, suffix included. Ported byte-for-byte; if the desktop
  // ever cleans this up, fix it here.
  const card = resolveSnapshotCard(
    entry({ filename: "ops.team.json", m: "application/json" }),
    URL,
    "ops.team.json",
  );
  assert.equal(card.displayName, "ops.team.json");
});

test("fall-through: no imeta entry, no href, unknown suffix", () => {
  assert.equal(resolveSnapshotCard(undefined, URL, "label"), null);
  assert.equal(resolveSnapshotCard(entry(), undefined, "label"), null);
  assert.equal(
    resolveSnapshotCard(
      entry({ filename: "notes.txt" }),
      URL,
      "notes.txt",
    ),
    null,
  );
});

test("fall-through: png with a non-png MIME is inconsistent", () => {
  assert.equal(
    resolveSnapshotCard(entry({ m: "image/jpeg" }), URL, "Night Shift"),
    null,
  );
});

test("fall-through: no sha256, wrong length, or non-hex 64", () => {
  assert.equal(resolveSnapshotCard(entry({ x: undefined }), URL, "x"), null);
  assert.equal(
    resolveSnapshotCard(entry({ x: SHA.slice(0, 63) }), URL, "x"),
    null,
  );
  // Web delta (documented in-file): 64 non-hex characters can never verify.
  assert.equal(
    resolveSnapshotCard(entry({ x: "g".repeat(64) }), URL, "x"),
    null,
  );
});

test("sha256 is normalized to lowercase for the fetch comparison", () => {
  const card = resolveSnapshotCard(entry({ x: SHA.toUpperCase() }), URL, "x");
  assert.equal(card.sha256, SHA);
});

test("x with surrounding whitespace still classifies (desktop trims)", () => {
  const card = resolveSnapshotCard(entry({ x: ` ${SHA} ` }), URL, "x");
  assert.equal(card.sha256, SHA);
});

test("unrelated sha in a different entry is not consulted (map discipline)", () => {
  const map = imetaByUrl([
    [
      "imeta",
      `url ${URL}`,
      "m image/png",
      `x ${OTHER_SHA}`,
      "size 10",
      "filename night-shift.agent.png",
    ],
  ]);
  // Entry for this href carries ITS OWN x; a different url's x is irrelevant.
  assert.equal(map.get(URL).x, OTHER_SHA);
  const card = resolveSnapshotCard(map.get(URL), URL, "Night Shift");
  assert.equal(card.sha256, OTHER_SHA);
});
