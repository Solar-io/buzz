import assert from "node:assert/strict";
import { test } from "node:test";
import {
  catalogCoordinateKey,
  catalogPublicationsByKey,
  mergeVerifiedCatalogEvent,
  parseCatalogAgent,
  publicationsFromVerifiedEvents,
  safeAvatar,
} from "./personaCatalog.ts";

/**
 * The persona-catalog trust boundary, pinned with hardcoded expectations:
 * head selection (claim BEFORE visibility), the exactly-one shared tag, the
 * rule-12 rejection, the allowlist→owner-only projection, and every
 * safeAvatar branch. Fixture events are raw SignedNostrEvent JSON — the same
 * shape the relay delivers — with arbitrary ids (the lib never hashes them).
 *
 * NAMED MUTATION (tester): in personaCatalog.ts move the `claimed.add(...)`
 * line AFTER the `exactTag(event, "shared") !== "true"` check, then
 * `unshared newest head suppresses the older shared head` must FAIL (the
 * older shared event is resurrected). Revert.
 */

const OWNER_A =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OWNER_B =
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

let eventSeq = 0;

function ev(overrides = {}) {
  eventSeq += 1;
  return {
    id: `id-${String(eventSeq).padStart(4, "0")}`,
    pubkey: OWNER_A,
    created_at: 1_700_000_000,
    kind: 30175,
    tags: [
      ["d", "night-shift"],
      ["shared", "true"],
    ],
    content: JSON.stringify({
      display_name: "Night Shift",
      system_prompt: "You work nights.",
    }),
    sig: "sig",
    ...overrides,
  };
}

test("single shared publication round-trips its projection", () => {
  const publications = publicationsFromVerifiedEvents([
    ev({
      id: "e1",
      content: JSON.stringify({
        display_name: "Night Shift",
        system_prompt: "You work nights.",
        runtime: "claude",
        model: "glm-5.3",
        provider: "zai",
        name_pool: ["Alice"],
        respond_to: "anyone",
        parallelism: 4,
        avatar_url: "https://relay.example/media/avatar.png",
      }),
      created_at: 1_700_000_500,
    }),
  ]);
  assert.deepEqual(publications, [
    {
      eventId: "e1",
      ownerPubkey: OWNER_A,
      sourcePersonaId: "night-shift",
      createdAt: 1_700_000_500,
      agent: {
        displayName: "Night Shift",
        avatarUrl: "https://relay.example/media/avatar.png",
        systemPrompt: "You work nights.",
        runtime: "claude",
        model: "glm-5.3",
        provider: "zai",
        namePool: ["Alice"],
        respondTo: "anyone",
        parallelism: 4,
      },
    },
  ]);
});

test("newest head wins for the same coordinate", () => {
  const publications = publicationsFromVerifiedEvents([
    ev({ id: "older", created_at: 100, content: oldContent("Old Name") }),
    ev({ id: "newer", created_at: 200 }),
  ]);
  assert.equal(publications.length, 1);
  assert.equal(publications[0].eventId, "newer");
  assert.equal(publications[0].agent.displayName, "Night Shift");
});

function oldContent(name) {
  return JSON.stringify({
    display_name: name,
    system_prompt: "Stale.",
  });
}

test("unshared newest head suppresses the older shared head", () => {
  // THE claim-before-visibility case: the unshared newer event claims the
  // coordinate, so the older shared event must NOT be resurrected.
  const publications = publicationsFromVerifiedEvents([
    ev({ id: "old-shared", created_at: 100, content: oldContent("Old Shared") }),
    ev({
      id: "new-unshared",
      created_at: 200,
      tags: [["d", "night-shift"]],
    }),
  ]);
  assert.deepEqual(publications, []);
});

test("malformed newest head also suppresses the older shared head", () => {
  const publications = publicationsFromVerifiedEvents([
    ev({ id: "old-shared", created_at: 100, content: oldContent("Old Shared") }),
    ev({ id: "new-bad-json", created_at: 200, content: "{not json" }),
  ]);
  assert.deepEqual(publications, []);
});

test("non-shared events are skipped entirely", () => {
  const publications = publicationsFromVerifiedEvents([
    ev({ id: "a", tags: [["d", "night-shift"]] }),
    ev({ id: "b", tags: [["d", "other"], ["shared", "false"]] }),
  ]);
  assert.deepEqual(publications, []);
});

test("tie on created_at claims the lower event id first", () => {
  const publications = publicationsFromVerifiedEvents([
    ev({ id: "bb", created_at: 100, content: oldContent("B Head") }),
    ev({ id: "aa", created_at: 100 }),
  ]);
  assert.equal(publications.length, 1);
  assert.equal(publications[0].eventId, "aa");
  assert.equal(publications[0].agent.displayName, "Night Shift");
});

test("two owners with the same d tag are separate coordinates", () => {
  const publications = publicationsFromVerifiedEvents([
    ev({ id: "a", pubkey: OWNER_A, created_at: 100 }),
    ev({ id: "b", pubkey: OWNER_B, created_at: 90 }),
  ]);
  assert.equal(publications.length, 2);
  assert.deepEqual(
    publications.map((p) => p.ownerPubkey).sort(),
    [OWNER_A, OWNER_B],
  );
});

test("shared tag must be exactly one [" + 'shared,"true"] pair', () => {
  // Zero shared tags.
  assert.deepEqual(
    publicationsFromVerifiedEvents([
      ev({ id: "none", tags: [["d", "night-shift"]] }),
    ]),
    [],
  );
  // A third value on the tag disqualifies it (exact_tag mirror).
  assert.deepEqual(
    publicationsFromVerifiedEvents([
      ev({
        id: "three",
        tags: [["d", "night-shift"], ["shared", "true", "x"]],
      }),
    ]),
    [],
  );
  // Two shared tags disqualify it.
  assert.deepEqual(
    publicationsFromVerifiedEvents([
      ev({
        id: "dup",
        tags: [
          ["d", "night-shift"],
          ["shared", "true"],
          ["shared", "true"],
        ],
      }),
    ]),
    [],
  );
});

test("d tag must exist exactly once and be non-empty", () => {
  assert.deepEqual(publicationsFromVerifiedEvents([ev({ id: "x", tags: [] })]), []);
  assert.deepEqual(
    publicationsFromVerifiedEvents([
      ev({
        id: "x",
        tags: [
          ["d", "one"],
          ["d", "two"],
          ["shared", "true"],
        ],
      }),
    ]),
    [],
  );
  assert.deepEqual(
    publicationsFromVerifiedEvents([
      ev({ id: "x", tags: [["d", ""], ["shared", "true"]] }),
    ]),
    [],
  );
});

test("wrong kind is ignored", () => {
  assert.deepEqual(
    publicationsFromVerifiedEvents([ev({ id: "x", kind: 30176 })]),
    [],
  );
});

test("rule-12-violating content is skipped entirely (U+200B in prompt)", () => {
  const publications = publicationsFromVerifiedEvents([
    ev({
      id: "zwsp",
      content: JSON.stringify({
        display_name: "Night Shift",
        system_prompt: "You work​nights.",
      }),
    }),
  ]);
  assert.deepEqual(publications, []);
});

test("rule-12-violating display name is skipped entirely (bidi override)", () => {
  const publications = publicationsFromVerifiedEvents([
    ev({
      id: "bidi",
      content: JSON.stringify({
        display_name: "Night‮Shift",
        system_prompt: "ok",
      }),
    }),
  ]);
  assert.deepEqual(publications, []);
});

test("malformed content shapes are skipped", () => {
  const cases = [
    "{not json",
    "[]",
    "null",
    JSON.stringify({ system_prompt: "no display name" }),
    JSON.stringify({ display_name: 42, system_prompt: "x" }),
  ];
  for (const content of cases) {
    assert.deepEqual(
      publicationsFromVerifiedEvents([ev({ id: "case", content })]),
      [],
      `content ${content} must not publish`,
    );
  }
});

test("respond_to projection: allowlist maps to owner-only, junk to null", () => {
  assert.equal(
    parseCatalogAgent(
      JSON.stringify({
        display_name: "N",
        system_prompt: "p",
        respond_to: "allowlist",
      }),
    ).respondTo,
    "owner-only",
  );
  assert.equal(
    parseCatalogAgent(
      JSON.stringify({
        display_name: "N",
        system_prompt: "p",
        respond_to: "anyone",
      }),
    ).respondTo,
    "anyone",
  );
  assert.equal(
    parseCatalogAgent(
      JSON.stringify({
        display_name: "N",
        system_prompt: "p",
        respond_to: "nonsense",
      }),
    ).respondTo,
    null,
  );
  assert.equal(
    parseCatalogAgent(JSON.stringify({ display_name: "N", system_prompt: "p" }))
      .respondTo,
    null,
  );
});

test("parallelism clamps to 1..=32 integers only", () => {
  const parse = (parallelism) =>
    parseCatalogAgent(
      JSON.stringify({ display_name: "N", system_prompt: "p", parallelism }),
    ).parallelism;
  assert.equal(parse(1), 1);
  assert.equal(parse(32), 32);
  assert.equal(parse(0), null);
  assert.equal(parse(33), null);
  assert.equal(parse(-1), null);
  assert.equal(parse(4.5), null);
  assert.equal(parse("4"), null);
});

test("optional strings: blank stays null, non-blank kept verbatim", () => {
  const agent = parseCatalogAgent(
    JSON.stringify({
      display_name: "N",
      system_prompt: "p",
      runtime: "   ",
      model: "glm-5.3",
      provider: "  zai  ",
    }),
  );
  assert.equal(agent.runtime, null);
  assert.equal(agent.model, "glm-5.3");
  assert.equal(agent.provider, "  zai  ");
});

test("name_pool drops non-string entries", () => {
  const agent = parseCatalogAgent(
    JSON.stringify({
      display_name: "N",
      system_prompt: "p",
      name_pool: ["Alice", 7, null, "Bob"],
    }),
  );
  assert.deepEqual(agent.namePool, ["Alice", "Bob"]);
});

test("safeAvatar: every branch", () => {
  // http(s) accepted.
  assert.equal(safeAvatar("https://relay.example/a.png"), true);
  assert.equal(safeAvatar("http://relay.example/a.png"), true);
  // Scheme gate.
  assert.equal(safeAvatar("javascript:alert(1)"), false);
  assert.equal(safeAvatar("ftp://relay.example/a.png"), false);
  assert.equal(safeAvatar("not a url"), false);
  // Whitespace / parens gate.
  assert.equal(safeAvatar("https://relay.example/a b.png"), false);
  assert.equal(safeAvatar("https://relay.example/a(b).png"), false);
  // HTTP length cap (bytes): pad to exactly 2048 (ok) and 2049 (rejected) —
  // the exact lengths are asserted, not hand-counted.
  const urlOfLength = (total) =>
    "https://x.example/" +
    "a".repeat(total - "https://x.example/".length - ".png".length) +
    ".png";
  assert.equal(urlOfLength(2048).length, 2048);
  assert.equal(safeAvatar(urlOfLength(2048)), true);
  assert.equal(urlOfLength(2049).length, 2049);
  assert.equal(safeAvatar(urlOfLength(2049)), false);
  // Inline SVG cap.
  const svgOk = `data:image/svg+xml,${"<svg>".repeat(100)}`; // ~600 bytes
  assert.ok(svgOk.length <= 8192);
  assert.equal(safeAvatar(svgOk), true);
  const svgTooBig = `data:image/svg+xml,${"a".repeat(8193)}`;
  assert.equal(safeAvatar(svgTooBig), false);
  // Base64 raster: payload length % 4.
  assert.equal(
    safeAvatar("data:image/png;base64,QUJDRA=="), // payload "QUJDRA==" len 8
    true,
  );
  assert.equal(
    safeAvatar("data:image/png;base64,QUJD"), // len 4 — ok
    true,
  );
  assert.equal(
    safeAvatar("data:image/png;base64,QUJDR"), // len 5 — % 4 != 0
    false,
  );
  assert.equal(
    safeAvatar("data:image/png;base64,!!!!"), // bad charset — no regex match
    false,
  );
  // Raster over the total cap falls through to the http branch and fails it.
  assert.equal(
    safeAvatar(`data:image/png;base64,${"A".repeat(256 * 1024)}`),
    false,
  );
});

test("avatar_url is null unless safeAvatar passes", () => {
  const parse = (avatar_url) =>
    parseCatalogAgent(
      JSON.stringify({ display_name: "N", system_prompt: "p", avatar_url }),
    ).avatarUrl;
  assert.equal(parse("https://relay.example/a.png"), "https://relay.example/a.png");
  assert.equal(parse("javascript:alert(1)"), null);
  assert.equal(parse(42), null);
});

test("coordinate key + publications-by-key map", () => {
  assert.equal(
    catalogCoordinateKey(OWNER_A.toUpperCase(), "night-shift"),
    `${OWNER_A}:night-shift`,
  );
  const byKey = catalogPublicationsByKey(
    publicationsFromVerifiedEvents([
      ev({ id: "a", pubkey: OWNER_A, created_at: 100 }),
      ev({ id: "b", pubkey: OWNER_B, created_at: 90 }),
    ]),
  );
  assert.equal(byKey.size, 2);
  assert.ok(byKey.has(`${OWNER_A}:night-shift`));
  assert.ok(byKey.has(`${OWNER_B}:night-shift`));
});

test("mergeVerifiedCatalogEvent dedupes by id and stays reference-stable", () => {
  const first = ev({ id: "same" });
  let events = new Map();
  events = mergeVerifiedCatalogEvent(events, first);
  const merged = mergeVerifiedCatalogEvent(events, first);
  assert.equal(merged, events); // no copy for a repeat
  events = mergeVerifiedCatalogEvent(events, ev({ id: "other" }));
  assert.equal(events.size, 2);
});

test("a late-arriving unshared newest head still suppresses the shared one", () => {
  // The live-subscription shape: shared event arrives first, the newer
  // unshared head arrives later. Re-deriving from the accumulated set must
  // drop the publication — the resurrection guard holds incrementally, too.
  let events = new Map();
  events = mergeVerifiedCatalogEvent(
    events,
    ev({ id: "shared-first", created_at: 100 }),
  );
  assert.equal(
    publicationsFromVerifiedEvents(events.values()).length,
    1,
  );
  events = mergeVerifiedCatalogEvent(
    events,
    ev({ id: "unshared-later", created_at: 200, tags: [["d", "night-shift"]] }),
  );
  assert.deepEqual(publicationsFromVerifiedEvents(events.values()), []);
});
