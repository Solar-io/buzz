import assert from "node:assert/strict";
import test from "node:test";

import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import * as nip44 from "nostr-tools/nip44";

import {
  CORE_SLUG,
  decodeEngramListing,
  deriveDTag,
  extractRefs,
  parseEngramBody,
  selectHead,
  validateSlug,
} from "./engrams.ts";
import { buildMemoryGraph } from "./buildMemoryGraph.ts";
import { parseStrictJson, StrictJsonError } from "./strictJson.ts";

// ── NIP-AE reference test vectors ───────────────────────────────────────────
// Verbatim from docs/nips/NIP-AE.md § Reference test vectors. TEST KEYS —
// they are the spec's pinned values (seckey = 1 and 2), never production keys.
// Using the published vectors rather than self-generated fixtures means the
// d-tag HMAC, the NIP-44 conversation key, and the event ids are all checked
// against an independent source instead of against this implementation's own
// output.

const SECKEY_A_HEX =
  "0000000000000000000000000000000000000000000000000000000000000001";
const SECKEY_O_HEX =
  "0000000000000000000000000000000000000000000000000000000000000002";
const PUBKEY_A =
  "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const PUBKEY_O =
  "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";

const D_CORE =
  "bdc233238ffe52e272b44cc233c8f33a2bc510b08be04495b225964283be4a90";
const D_MEM_EXAMPLE =
  "72d4f9629106451505d7d341ea85bb3ebad4f654fcfd2aad100d5a35f8a85cba";
const D_MEM_NOTES =
  "31651571a312780cfdc1f0b706b682ac9f3f51a053e8dca76fe57710bae5a4d4";

/** Event 1 — write `mem/example`. */
const VECTOR_EVENT_1 = {
  id: "f4a594177b7aeea4fe99a09efbf74ae85f0126244f322135682c405888a38689",
  pubkey: PUBKEY_A,
  created_at: 1700000000,
  kind: 30174,
  tags: [
    ["d", D_MEM_EXAMPLE],
    ["p", PUBKEY_O],
  ],
  content:
    "AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABedgcxyfmpph68LBjCWZsTI5lb0Cbg8dIPVYVe/WVj/l4Yd8HGgzC8awyBi9bn9ClRdtd2IPsmont0jN/cajVSQhahTOwuNNwoJtZIg35aSsUzeCq4tQfd8E+fLoKomdPxjs=",
  sig: "0a4582f0bc5995b9a010afda5984f568055988ebbe4552b4e0ec6d11aeb2b303af940f3d84726a7edd1763badb284eb3aa8457664ceba85a90d6252ed4b494cb",
};

/** Event 2 — write `mem/notes/2026-05-12`. */
const VECTOR_EVENT_2 = {
  id: "1a43298ea1fa9b73462a85b9f16f5f6bd2a7ab18b0b02424e5ec3f3b8a48e030",
  pubkey: PUBKEY_A,
  created_at: 1700000001,
  kind: 30174,
  tags: [
    ["d", D_MEM_NOTES],
    ["p", PUBKEY_O],
  ],
  content:
    "AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACG/JBPvdZxDwAxOG7bY3AW2q1slZqBjQC3NxfPVtfcR+TGjp2GKtjyXyqNwG08GK+00I1u1vUZ4cCjcun9A7ra92rleKKJ5w57pqgFspbv1vClUJY5487A/5phVDHkw6DhRCSMDpEMw5Tapj3Wm1ponAVr5PciPOrTxltEfTVdSKaPA==",
  sig: "dc9da456db1c89f070edc5f994786f270fc00e8ff19f33d5b0f6cea49421cd727fcd79bb288f3e3dbd5af9ca1ba67f9bd11b02a47c1e6c37cfd32665c17e4a24",
};

/** Event 3 — tombstone `mem/example` (supersedes event 1: same `d`, later). */
const VECTOR_EVENT_3 = {
  id: "c8604bef05295856a67a88ec895e07b5b47a2febc23c82934734096a7b123b63",
  pubkey: PUBKEY_A,
  created_at: 1700000002,
  kind: 30174,
  tags: [
    ["d", D_MEM_EXAMPLE],
    ["p", PUBKEY_O],
  ],
  content:
    "AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADuau8i0Wu4+ULnp2qTfd+O23jJAapMRrKGGwabNVOlT9hSF8FViBHIS6f86/7xK4qGOin4IH8Wr/3cvHDcQGQd3IXQJr8LHgJkaYpQPdBO1bgqiFu8K3L/CLb1PgG1X7RQ8E=",
  sig: "c8d53859cf08b3a9a20a5b01c61d12fa2f082f462adb635420f05dc6f9bb662a174e729023854bf53e5e35fae8f6f4c9d604e8979a070e298cd77cfb7e6b6468",
};

/** Event 4 — core profile referencing both memories. */
const VECTOR_EVENT_4 = {
  id: "980419c4d231266471242456c832d0c2eb1e6974468dc795f3ae327484129058",
  pubkey: PUBKEY_A,
  created_at: 1700000003,
  kind: 30174,
  tags: [
    ["d", D_CORE],
    ["p", PUBKEY_O],
  ],
  content:
    "AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEEeZHAFjhc8DAcKaVSSB7IoKG3nr+dX3LXlU7UIdOKayhIVPXvl4WuFmBSVxLO6yEV5vnLvzbo7rU0uPRYyAJLPNnifVTCw2EQZH70zOwTc/mVvaATHKzqcFo5VHrbpKNTzeNnz1Vds2yg2DXmdxaoWQA4YfnlLwZDOpyu9JP1uB1Yw==",
  sig: "ce113fff1205eadb38928b224a90247be1a00b0c3f8ab583d4a5f7274ddba51ebb5eb9d627d44664a78d2e870e61835cf61446cc812ecea139e8b7d41b8e238f",
};

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

const SECKEY_A = hexToBytes(SECKEY_A_HEX);
const SECKEY_O = hexToBytes(SECKEY_O_HEX);

/** Decode as the OWNER would: their own seckey, the agent as the peer. */
function decodeAsOwner(events, extra = {}) {
  return decodeEngramListing({
    events,
    agentPubkey: PUBKEY_A,
    ownerPubkey: PUBKEY_O,
    ownerSecretKey: SECKEY_O,
    truncated: false,
    nowSeconds: 1700000010,
    ...extra,
  });
}

/**
 * Sign a fresh engram event as the agent. Used where the spec vectors do not
 * cover a case (key mismatch, tampered `d`, tie-break). The `d` tag is derived
 * the same way a writer would, so these are real, valid engrams unless the
 * test deliberately breaks one.
 */
async function signEngram({
  seckey = SECKEY_A,
  ownerPubkey = PUBKEY_O,
  body,
  createdAt,
  dTagOverride,
  encryptToPubkey = null,
  encryptWithSeckey = null,
}) {
  const conversationKey = nip44.v2.utils.getConversationKey(
    encryptWithSeckey ?? seckey,
    encryptToPubkey ?? ownerPubkey,
  );
  const slug = body.slug;
  const d =
    dTagOverride ??
    (await deriveDTag(
      nip44.v2.utils.getConversationKey(seckey, ownerPubkey),
      slug,
    ));
  return finalizeEvent(
    {
      kind: 30174,
      created_at: createdAt,
      tags: [
        ["d", d],
        ["p", ownerPubkey],
      ],
      content: nip44.v2.encrypt(JSON.stringify(body), conversationKey),
    },
    seckey,
  );
}

// ── d-tag derivation ────────────────────────────────────────────────────────

test("deriveDTag reproduces the NIP-AE reference d tags", async () => {
  const kc = nip44.v2.utils.getConversationKey(SECKEY_O, PUBKEY_A);
  assert.equal(await deriveDTag(kc, "core"), D_CORE);
  assert.equal(await deriveDTag(kc, "mem/example"), D_MEM_EXAMPLE);
  assert.equal(await deriveDTag(kc, "mem/notes/2026-05-12"), D_MEM_NOTES);
});

test("deriveDTag is symmetric — agent and owner derive the same d tag", async () => {
  const fromOwner = nip44.v2.utils.getConversationKey(SECKEY_O, PUBKEY_A);
  const fromAgent = nip44.v2.utils.getConversationKey(SECKEY_A, PUBKEY_O);
  assert.equal(
    await deriveDTag(fromAgent, "mem/example"),
    await deriveDTag(fromOwner, "mem/example"),
  );
});

test("deriveDTag separates the domain prefix from the slug", async () => {
  // The 0x00 separator is what stops `"agent-memory/v1/d-tagX" + "y"` from
  // colliding with `"agent-memory/v1/d-tag" + "Xy"`. Distinct slugs must
  // never share a d tag.
  const kc = nip44.v2.utils.getConversationKey(SECKEY_O, PUBKEY_A);
  const a = await deriveDTag(kc, "mem/a");
  const b = await deriveDTag(kc, "mem/b");
  assert.notEqual(a, b);
});

// ── Slug grammar ────────────────────────────────────────────────────────────

test("validateSlug accepts core and well-formed mem slugs", () => {
  assert.equal(validateSlug("core"), true);
  assert.equal(validateSlug("mem/example"), true);
  assert.equal(validateSlug("mem/notes/2026-05-12"), true);
  assert.equal(validateSlug("mem/a_b-c/9"), true);
});

test("validateSlug rejects malformed slugs", () => {
  assert.equal(validateSlug(""), false);
  assert.equal(validateSlug("mem/"), false);
  assert.equal(validateSlug("mem//x"), false);
  assert.equal(validateSlug("notes/x"), false);
  assert.equal(validateSlug("mem/Example"), false, "uppercase rejected");
  assert.equal(validateSlug("mem/-lead"), false, "leading dash rejected");
  assert.equal(validateSlug("mem/a b"), false, "space rejected");
  assert.equal(validateSlug(`mem/${"a".repeat(65)}`), false, "segment > 64");
  assert.equal(
    validateSlug(
      `mem/${"a".repeat(60)}/${"b".repeat(60)}/${"c".repeat(60)}/${"d".repeat(60)}/${"e".repeat(60)}`,
    ),
    false,
    "total length > 255",
  );
});

// ── Ref extraction ──────────────────────────────────────────────────────────

test("extractRefs returns valid slugs in first-occurrence order, deduplicated", () => {
  assert.deepEqual(
    extractRefs("see [[mem/b]] then [[mem/a]] then [[mem/b]] again"),
    ["mem/b", "mem/a"],
  );
});

test("extractRefs ignores bare slugs and invalid candidates", () => {
  assert.deepEqual(extractRefs("mem/example is not a ref"), []);
  assert.deepEqual(extractRefs("[[]] [[not a slug!]] [[mem/ok]]"), ["mem/ok"]);
});

test("extractRefs restarts at an inner [[ rather than swallowing it", () => {
  // Ported behaviour from extract_refs in buzz-core/src/engram.rs.
  assert.deepEqual(extractRefs("[[outer [[mem/x]]"), ["mem/x"]);
});

test("extractRefs ignores an unterminated reference", () => {
  assert.deepEqual(extractRefs("[[mem/x but never closed"), []);
});

// ── Body parsing ────────────────────────────────────────────────────────────

test("parseEngramBody reads core and memory bodies", () => {
  assert.deepEqual(parseEngramBody('{"slug":"core","profile":"hi"}'), {
    kind: "core",
    slug: "core",
    profile: "hi",
  });
  assert.deepEqual(parseEngramBody('{"slug":"mem/a","value":"v"}'), {
    kind: "memory",
    slug: "mem/a",
    value: "v",
  });
  assert.deepEqual(parseEngramBody('{"slug":"mem/a","value":null}'), {
    kind: "memory",
    slug: "mem/a",
    value: null,
  });
});

test("parseEngramBody ignores unknown fields", () => {
  assert.deepEqual(
    parseEngramBody('{"slug":"mem/a","value":"v","trust":0.9}'),
    { kind: "memory", slug: "mem/a", value: "v" },
  );
});

test("parseEngramBody rejects wrong shapes", () => {
  assert.equal(parseEngramBody('{"slug":"core"}'), null, "core needs profile");
  assert.equal(parseEngramBody('{"slug":"mem/a"}'), null, "memory needs value");
  assert.equal(parseEngramBody('{"slug":"mem/a","value":7}'), null);
  assert.equal(parseEngramBody('{"slug":"bad slug","value":"v"}'), null);
  assert.equal(parseEngramBody('["slug"]'), null, "array is not a body");
  assert.equal(parseEngramBody("not json"), null);
});

test("parseEngramBody rejects duplicate member names (NIP-AE rule 3)", () => {
  // JSON.parse would silently last-win here, so a first-wins reader and a
  // last-wins reader would pick different heads for the same slug.
  assert.equal(
    parseEngramBody('{"slug":"mem/a","value":"one","value":"two"}'),
    null,
  );
  assert.equal(
    parseEngramBody('{"slug":"mem/a","value":"v","meta":{"x":1,"x":2}}'),
    null,
    "nested duplicates rejected too",
  );
});

test("parseStrictJson accepts ordinary JSON and rejects trailing data", () => {
  assert.deepEqual(parseStrictJson('{"a":[1,2,{"b":"c"}],"d":null}'), {
    a: [1, 2, { b: "c" }],
    d: null,
  });
  assert.throws(() => parseStrictJson('{"a":1} junk'), StrictJsonError);
  assert.throws(() => parseStrictJson('{"a":1,"a":1}'), StrictJsonError);
});

// ── Head selection ──────────────────────────────────────────────────────────

test("selectHead takes the greatest created_at", () => {
  const head = selectHead([
    { id: "aa", created_at: 5 },
    { id: "bb", created_at: 9 },
    { id: "cc", created_at: 7 },
  ]);
  assert.equal(head.id, "bb");
});

test("selectHead breaks created_at ties on the LOWEST event id", () => {
  const head = selectHead([
    { id: "ff", created_at: 9 },
    { id: "11", created_at: 9 },
    { id: "aa", created_at: 9 },
  ]);
  assert.equal(head.id, "11");
});

test("selectHead returns null for an empty set", () => {
  assert.equal(selectHead([]), null);
});

// ── End-to-end decode against the spec's signed events ──────────────────────

test("decodeEngramListing opens the NIP-AE reference events with the owner key", async () => {
  const listing = await decodeAsOwner([
    VECTOR_EVENT_1,
    VECTOR_EVENT_2,
    VECTOR_EVENT_3,
    VECTOR_EVENT_4,
  ]);

  assert.equal(listing.undecryptable, 0);
  assert.equal(listing.fetchedAt, 1700000010);

  assert.equal(listing.core?.slug, CORE_SLUG);
  assert.equal(
    listing.core?.body,
    "test agent. see [[mem/example]] and [[mem/notes/2026-05-12]].",
  );
  assert.equal(listing.core?.eventId, VECTOR_EVENT_4.id);
  assert.deepEqual(listing.core?.outgoingRefs, [
    "mem/example",
    "mem/notes/2026-05-12",
  ]);

  // Event 3 tombstones `mem/example` (same d tag, later created_at), so only
  // the notes entry survives.
  assert.equal(listing.memories.length, 1);
  assert.equal(listing.memories[0].slug, "mem/notes/2026-05-12");
  assert.equal(listing.memories[0].body, "meeting note: [[mem/example]]");
  assert.equal(listing.memories[0].eventId, VECTOR_EVENT_2.id);
  assert.deepEqual(listing.memories[0].outgoingRefs, ["mem/example"]);
});

test("decodeEngramListing keeps a memory whose tombstone is OLDER than the write", async () => {
  // Same two events as above minus the ordering that makes the tombstone win:
  // if the tombstone did not supersede, `mem/example` must come back. This is
  // the discriminating counterpart to the tombstone assertion — without it a
  // head-selection bug that always picked the FIRST event would still pass.
  const write = await signEngram({
    body: { slug: "mem/example", value: "hello, agent memory" },
    createdAt: 1700000005,
  });
  const listing = await decodeAsOwner([VECTOR_EVENT_3, write]);
  assert.equal(listing.memories.length, 1);
  assert.equal(listing.memories[0].slug, "mem/example");
  assert.equal(listing.memories[0].body, "hello, agent memory");
});

test("decodeEngramListing sorts memories by slug", async () => {
  const events = await Promise.all([
    signEngram({ body: { slug: "mem/zeta", value: "z" }, createdAt: 1 }),
    signEngram({ body: { slug: "mem/alpha", value: "a" }, createdAt: 2 }),
    signEngram({ body: { slug: "mem/mid", value: "m" }, createdAt: 3 }),
  ]);
  const listing = await decodeAsOwner(events);
  assert.deepEqual(
    listing.memories.map((m) => m.slug),
    ["mem/alpha", "mem/mid", "mem/zeta"],
  );
});

test("decodeEngramListing carries the truncated flag through", async () => {
  const listing = await decodeAsOwner([VECTOR_EVENT_4], { truncated: true });
  assert.equal(listing.truncated, true);
});

// ── Rejection paths: every one is COUNTED, never silently dropped ───────────

test("decodeEngramListing counts a frame encrypted to a different owner", async () => {
  // Encrypted under (agent, stranger) but p-tagged and d-tagged for our owner:
  // the envelope passes, the ciphertext does not open.
  const strangerSeckey = hexToBytes(
    "0000000000000000000000000000000000000000000000000000000000000003",
  );
  const strangerPubkey = getPublicKey(strangerSeckey);
  const event = await signEngram({
    body: { slug: "mem/secret", value: "not for you" },
    createdAt: 1700000100,
    encryptToPubkey: strangerPubkey,
  });
  const listing = await decodeAsOwner([event]);
  assert.equal(listing.undecryptable, 1);
  assert.equal(listing.memories.length, 0);
  assert.equal(listing.core, null);
});

test("decodeEngramListing counts a frame whose signature does not verify", async () => {
  const tampered = {
    ...VECTOR_EVENT_4,
    sig: `0${VECTOR_EVENT_4.sig.slice(1)}`,
  };
  const listing = await decodeAsOwner([tampered]);
  assert.equal(listing.undecryptable, 1);
  assert.equal(listing.core, null);
});

test("decodeEngramListing counts a frame whose d tag does not match its slug", async () => {
  // Rule (4): a valid, correctly-signed, decryptable event whose `d` tag was
  // derived for a DIFFERENT slug must be refused — otherwise an agent could
  // shadow one slug's address with another slug's content.
  const event = await signEngram({
    body: { slug: "mem/real", value: "v" },
    createdAt: 1700000200,
    dTagOverride: D_MEM_EXAMPLE,
  });
  const listing = await decodeAsOwner([event]);
  assert.equal(listing.undecryptable, 1);
  assert.equal(listing.memories.length, 0);
});

test("decodeEngramListing counts a frame p-tagged to someone else", async () => {
  const strangerSeckey = hexToBytes(
    "0000000000000000000000000000000000000000000000000000000000000004",
  );
  const strangerPubkey = getPublicKey(strangerSeckey);
  const event = await signEngram({
    body: { slug: "mem/other", value: "v" },
    createdAt: 1700000300,
    ownerPubkey: strangerPubkey,
  });
  const listing = await decodeAsOwner([event]);
  assert.equal(listing.undecryptable, 1);
  assert.equal(listing.memories.length, 0);
});

test("decodeEngramListing counts a frame authored by a different agent", async () => {
  const otherAgentSeckey = hexToBytes(
    "0000000000000000000000000000000000000000000000000000000000000005",
  );
  const event = await signEngram({
    seckey: otherAgentSeckey,
    body: { slug: "mem/imposter", value: "v" },
    createdAt: 1700000400,
  });
  const listing = await decodeAsOwner([event]);
  assert.equal(listing.undecryptable, 1);
  assert.equal(listing.memories.length, 0);
});

test("decodeEngramListing counts a frame of the wrong kind", async () => {
  const listing = await decodeAsOwner([{ ...VECTOR_EVENT_4, kind: 1 }]);
  assert.equal(listing.undecryptable, 1);
  assert.equal(listing.core, null);
});

test("decodeEngramListing counts a frame with two d tags", async () => {
  const listing = await decodeAsOwner([
    { ...VECTOR_EVENT_4, tags: [...VECTOR_EVENT_4.tags, ["d", D_CORE]] },
  ]);
  assert.equal(listing.undecryptable, 1);
  assert.equal(listing.core, null);
});

test("decodeEngramListing counts bad frames alongside good ones", async () => {
  const listing = await decodeAsOwner([
    VECTOR_EVENT_4,
    { ...VECTOR_EVENT_2, sig: `0${VECTOR_EVENT_2.sig.slice(1)}` },
  ]);
  assert.equal(listing.core?.slug, "core");
  assert.equal(listing.memories.length, 0);
  assert.equal(listing.undecryptable, 1);
});

// ── Decode → graph, the path the panel actually renders ─────────────────────

test("the reference listing builds the tree the viewer renders", async () => {
  const listing = await decodeAsOwner([
    VECTOR_EVENT_1,
    VECTOR_EVENT_2,
    VECTOR_EVENT_3,
    VECTOR_EVENT_4,
  ]);
  const graph = buildMemoryGraph(listing);

  assert.equal(graph.rootedTree?.entry.slug, "core");
  assert.equal(graph.rootedTree?.children.length, 1);
  assert.equal(
    graph.rootedTree?.children[0].entry.slug,
    "mem/notes/2026-05-12",
  );
  assert.deepEqual(graph.orphans, []);
  // `mem/example` is tombstoned, so both bodies that cite it dangle.
  assert.deepEqual(graph.dangling, [
    { slug: "mem/example", referencedBy: ["core", "mem/notes/2026-05-12"] },
  ]);
});
