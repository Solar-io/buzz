import assert from "node:assert/strict";
import { test } from "node:test";
import { npubEncode, nsecEncode } from "nostr-tools/nip19";

const {
  AGENTS_NOT_LOADED_MESSAGE,
  LAST_CALL_AGENT_KEY,
  agentReadsComplete,
  LAUNCH_INTENT_MAX_AGE_MS,
  NO_LAST_AGENT_MESSAGE,
  callableAgentsFromEvents,
  cleanAgentSelector,
  createLaunchConsumer,
  isLaunchIntentFresh,
  liveRoomWithAgent,
  parseLaunchUrl,
  readLastCallAgent,
  rememberLastCallAgent,
  resolveLaunchAgent,
  waitUntil,
} = await import("./launchIntent.ts");

const OWNER = "0".repeat(64);
const ACID = "a".repeat(64);
const GILF = "b".repeat(64);
const TWIN1 = "c".repeat(64);
const TWIN2 = "d".repeat(64);
const STRANGER = "e".repeat(64);
const AGENTS = [
  { pubkey: ACID, name: "Acid Burn" },
  { pubkey: GILF, name: "Gilfoyle" },
  { pubkey: TWIN1, name: "Cereal Killer" },
  { pubkey: TWIN2, name: "cereal killer" },
];

// ---------------------------------------------------------------- parsing

test("parseLaunchUrl accepts exactly the four launch shapes", () => {
  assert.deepEqual(parseLaunchUrl("buzzweb://"), { action: "open" });
  assert.deepEqual(parseLaunchUrl("buzzweb://open"), { action: "open" });
  assert.deepEqual(parseLaunchUrl("BUZZWEB://OPEN/"), { action: "open" });
  assert.deepEqual(parseLaunchUrl("buzzweb://call"), {
    action: "call",
    agent: null,
  });
  assert.deepEqual(parseLaunchUrl("buzzweb://call/"), {
    action: "call",
    agent: null,
  });
  assert.deepEqual(parseLaunchUrl("buzzweb://call?agent=Acid%20Burn"), {
    action: "call",
    agent: "Acid Burn",
  });
  assert.deepEqual(parseLaunchUrl("buzzweb://call?agent=%20Gilfoyle%09"), {
    action: "call",
    agent: "Gilfoyle",
  });
});

test("parseLaunchUrl refuses other schemes, hosts, paths and params", () => {
  for (const raw of [
    "",
    "not a url",
    "buzz://call",
    "https://call?agent=x",
    "capacitor://localhost/call",
    "buzzweb:call",
    "buzzweb://dial",
    "buzzweb://call/now",
    "buzzweb://call#x",
    "buzzweb://user:pw@call",
    "buzzweb://call:8080",
    "buzzweb://open?agent=Gilfoyle",
    "buzzweb://?agent=Gilfoyle",
    "buzzweb://call?who=Gilfoyle",
    "buzzweb://call?agent=Gilfoyle&agent=Acid",
    "buzzweb://call?agent=Gilfoyle&x=1",
    "buzzweb://call?agent=",
    "buzzweb://call?agent=%20%20",
    "buzzweb://call?agent=Gil%0Afoyle",
    "buzzweb://call?agent=Gil%E2%80%8Bfoyle", // U+200B, a Cf format char
    `buzzweb://call?agent=${"x".repeat(129)}`,
  ]) {
    assert.equal(parseLaunchUrl(raw), null, raw);
  }
});

test("parseLaunchUrl matches the shared native corpus, case for case", async () => {
  // Same file LaunchPluginTests.swift reads, so native and web cannot drift
  // on what a link means (QA 2026-10-01: `c%61ll`, `Big+Head`).
  const { readFile } = await import("node:fs/promises");
  const corpus = JSON.parse(
    await readFile(
      new URL(
        "../../../../../test-fixtures/launch-links/cases.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(corpus.cases.length, corpus.count);
  assert.ok(corpus.count >= 70, "the corpus did not load its cases");
  for (const { url, expect } of corpus.cases) {
    assert.deepEqual(parseLaunchUrl(url), expect, JSON.stringify(url));
  }
});

test("`+` is a space and `%2B` a plus; a percent-encoded host is refused", () => {
  assert.deepEqual(parseLaunchUrl("buzzweb://call?agent=Big+Head"), {
    action: "call",
    agent: "Big Head",
  });
  assert.deepEqual(parseLaunchUrl("buzzweb://call?agent=Big%2BHead"), {
    action: "call",
    agent: "Big+Head",
  });
  assert.equal(parseLaunchUrl("buzzweb://c%61ll?agent=Gilfoyle"), null);
  assert.equal(parseLaunchUrl("buzzweb://user@call"), null);
  assert.equal(parseLaunchUrl("buzzweb://@call"), null);
  assert.equal(parseLaunchUrl("buzzweb://call#"), null);
  assert.equal(parseLaunchUrl("buzzweb://call?agent=%zz"), null);
});

test("cleanAgentSelector counts code points, matching Swift unicodeScalars", () => {
  assert.equal(cleanAgentSelector("x".repeat(128)), "x".repeat(128));
  assert.equal(cleanAgentSelector("😀".repeat(128))?.length, 256);
  assert.equal(cleanAgentSelector("😀".repeat(129)), null);
  // NBSP is Zs (trimmed on both sides); U+FEFF is Cf (refused on both).
  assert.equal(cleanAgentSelector(" Gilfoyle "), "Gilfoyle");
  assert.equal(cleanAgentSelector("﻿Gilfoyle"), null);
});

// ------------------------------------------------------------- resolution

test("an explicit name resolves case-insensitively to one agent", () => {
  assert.deepEqual(resolveLaunchAgent("acid burn", AGENTS, null), {
    ok: true,
    agent: { pubkey: ACID, name: "Acid Burn" },
  });
  assert.deepEqual(resolveLaunchAgent("GILFOYLE", AGENTS, null), {
    ok: true,
    agent: { pubkey: GILF, name: "Gilfoyle" },
  });
});

test("an ambiguous name is refused, not guessed", () => {
  const result = resolveLaunchAgent("Cereal Killer", AGENTS, null);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "ambiguous");
  assert.match(result.message, /More than one/);
});

test("hex and npub select an owned agent; a stranger's key is refused", () => {
  assert.equal(resolveLaunchAgent(GILF, AGENTS, null).agent?.pubkey, GILF);
  assert.equal(
    resolveLaunchAgent(GILF.toUpperCase(), AGENTS, null).agent?.pubkey,
    GILF,
  );
  assert.equal(
    resolveLaunchAgent(npubEncode(TWIN2), AGENTS, null).agent?.pubkey,
    TWIN2,
  );
  const stranger = resolveLaunchAgent(npubEncode(STRANGER), AGENTS, null);
  assert.equal(stranger.ok, false);
  assert.equal(stranger.reason, "unknown");
  assert.equal(resolveLaunchAgent("Nobody", AGENTS, null).reason, "unknown");
});

test("a secret key in the link is refused with the specific error", () => {
  const nsec = nsecEncode(new Uint8Array(32).fill(7));
  const result = resolveLaunchAgent(nsec, AGENTS, null);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid");
  assert.match(result.message, /SECRET/);
});

test("no selector calls the last agent, with its current registry name", () => {
  const result = resolveLaunchAgent(null, AGENTS, {
    pubkey: GILF,
    name: "Old Name",
  });
  assert.deepEqual(result, {
    ok: true,
    agent: { pubkey: GILF, name: "Gilfoyle" },
  });
});

test("no selector and no last agent asks for one call first", () => {
  assert.deepEqual(resolveLaunchAgent(null, AGENTS, null), {
    ok: false,
    reason: "no-last",
    message: NO_LAST_AGENT_MESSAGE,
  });
});

test("a last agent no longer in the registry is refused", () => {
  const result = resolveLaunchAgent(null, AGENTS, {
    pubkey: STRANGER,
    name: "Zero Cool",
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unavailable");
  assert.match(result.message, /Zero Cool/);
});

test("a partial agent list turns misses and ties into 'couldn't load'", () => {
  const notLoaded = {
    ok: false,
    reason: "incomplete",
    message: AGENTS_NOT_LOADED_MESSAGE,
  };
  // Each "not found" shape, against an empty (timed-out) list.
  assert.deepEqual(resolveLaunchAgent("Gilfoyle", [], null, false), notLoaded);
  assert.deepEqual(resolveLaunchAgent(GILF, [], null, false), notLoaded);
  assert.deepEqual(
    resolveLaunchAgent(null, [], { pubkey: GILF, name: "Gilfoyle" }, false),
    notLoaded,
  );
  assert.deepEqual(
    resolveLaunchAgent("Cereal Killer", AGENTS, null, false),
    notLoaded,
  );
  // The same misses on a COMPLETE list stay genuine "not found".
  assert.equal(resolveLaunchAgent("Gilfoyle", [], null).reason, "unknown");
  assert.equal(
    resolveLaunchAgent(null, [], { pubkey: GILF, name: "Gilfoyle" }).reason,
    "unavailable",
  );
  // A match in a partial list is still one of the owner's agents.
  assert.equal(
    resolveLaunchAgent("Gilfoyle", AGENTS, null, false).agent?.pubkey,
    GILF,
  );
  // Neither depends on the list, so neither becomes "couldn't load".
  assert.equal(resolveLaunchAgent(null, [], null, false).reason, "no-last");
  const nsec = nsecEncode(new Uint8Array(32).fill(7));
  assert.equal(resolveLaunchAgent(nsec, [], null, false).reason, "invalid");
});

test("agent reads are complete only with EOSE and an unfilled page", () => {
  const read = (n, eose, limit = 3) => ({
    events: Array.from({ length: n }),
    eose,
    limit,
  });
  assert.equal(agentReadsComplete([read(2, true), read(0, true)]), true);
  assert.equal(agentReadsComplete([read(2, true), read(0, false)]), false);
  assert.equal(agentReadsComplete([read(0, false), read(0, true)]), false);
  assert.equal(agentReadsComplete([read(3, true)]), false, "a full page");
});

// ------------------------------------------------------ last-agent storage

function memoryStorage() {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
  };
}

test("the last agent round-trips per identity", () => {
  const storage = memoryStorage();
  rememberLastCallAgent(storage, OWNER, {
    pubkey: GILF.toUpperCase(),
    name: "Gilfoyle",
  });
  assert.deepEqual(readLastCallAgent(storage, OWNER), {
    pubkey: GILF,
    name: "Gilfoyle",
  });
  assert.equal(readLastCallAgent(storage, "f".repeat(64)), null);
  assert.equal(readLastCallAgent(storage, null), null);
  assert.equal(readLastCallAgent(null, OWNER), null);
});

test("a later successful call replaces the last agent", () => {
  const storage = memoryStorage();
  rememberLastCallAgent(storage, OWNER, { pubkey: GILF, name: "Gilfoyle" });
  rememberLastCallAgent(storage, OWNER, { pubkey: ACID, name: "Acid Burn" });
  assert.equal(readLastCallAgent(storage, OWNER)?.pubkey, ACID);
});

test("corrupt or hostile stored values read as no last agent", () => {
  const storage = memoryStorage();
  for (const raw of [
    "not json",
    "null",
    JSON.stringify({ owner: OWNER, pubkey: "xyz", name: "x" }),
    JSON.stringify({ owner: OWNER, pubkey: GILF }),
  ]) {
    storage.map.set(LAST_CALL_AGENT_KEY, raw);
    assert.equal(readLastCallAgent(storage, OWNER), null, raw);
  }
  const throwing = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
  };
  assert.equal(readLastCallAgent(throwing, OWNER), null);
  assert.doesNotThrow(() =>
    rememberLastCallAgent(throwing, OWNER, { pubkey: GILF, name: "G" }),
  );
});

// ------------------------------------------------ registry and live rooms

const registryEvent = (pubkey, name, at = 100) => ({
  id: `r-${pubkey}-${at}`,
  pubkey: OWNER,
  created_at: at,
  kind: 30177,
  tags: [["d", pubkey]],
  content: JSON.stringify({ name }),
  sig: "s",
});

test("callable agents are the owner's registry, newest name wins", () => {
  const agents = callableAgentsFromEvents(
    [
      registryEvent(GILF, "Gilfoyle", 100),
      registryEvent(GILF, "Gilfoyle 2", 200),
      registryEvent(ACID, "Acid Burn"),
      { ...registryEvent(STRANGER, "Junk"), kind: 1 },
    ],
    [],
  );
  assert.deepEqual(
    agents.sort((a, b) => a.pubkey.localeCompare(b.pubkey)),
    [
      { pubkey: ACID, name: "Acid Burn" },
      { pubkey: GILF, name: "Gilfoyle 2" },
    ],
  );
});

test("an authoritative catalog hides a deleted twin, so its name resolves", () => {
  const now = 10_000;
  const catalog = {
    id: "cat",
    pubkey: OWNER,
    created_at: now,
    kind: 30180,
    tags: [["d", "crichton.local"]],
    content: JSON.stringify({
      format: "buzz-desktop-catalog",
      version: 4,
      machine: "crichton.local",
      updated_at: now,
      agents: [TWIN1, GILF],
    }),
    sig: "s",
  };
  const agents = callableAgentsFromEvents(
    [
      registryEvent(TWIN1, "Cereal Killer"),
      registryEvent(TWIN2, "cereal killer", 200),
      registryEvent(GILF, "Gilfoyle"),
    ],
    [catalog],
    now,
  );
  assert.equal(
    resolveLaunchAgent("Cereal Killer", agents, null).agent?.pubkey,
    TWIN1,
  );
});

const lifecycle = (kind, who, ephemeralId, revision) => ({
  id: `${kind}:${who}:${revision}`,
  pubkey: "relay",
  created_at: 100 + revision,
  kind,
  tags: [
    ["h", "dm"],
    ["p", who],
  ],
  content: JSON.stringify({
    ephemeral_channel_id: ephemeralId,
    roster_revision: revision,
  }),
  sig: "s",
});

test("liveRoomWithAgent reuses a live room the agent is in", () => {
  const events = [
    lifecycle(48101, OWNER, "room-1", 1),
    lifecycle(48101, GILF, "room-1", 2),
    lifecycle(48101, OWNER, "room-2", 1),
  ];
  assert.equal(liveRoomWithAgent(events, "dm", GILF.toUpperCase()), "room-1");
  assert.equal(liveRoomWithAgent(events, "dm", ACID), null);
  assert.equal(liveRoomWithAgent(events, "other-dm", GILF), null);
});

test("liveRoomWithAgent ignores a room the agent left or that ended", () => {
  assert.equal(
    liveRoomWithAgent(
      [
        lifecycle(48101, GILF, "room-1", 1),
        lifecycle(48102, GILF, "room-1", 2),
        lifecycle(48101, OWNER, "room-1", 3),
      ],
      "dm",
      GILF,
    ),
    null,
  );
  assert.equal(
    liveRoomWithAgent(
      [
        lifecycle(48101, GILF, "room-1", 1),
        { ...lifecycle(48103, GILF, "room-1", 2), tags: [["h", "dm"]] },
      ],
      "dm",
      GILF,
    ),
    null,
  );
});

// --------------------------------------------------------- consume once

const NOW = 1_000_000;
function fakeSource(intent) {
  const state = { intent, acks: [], getCalls: 0, failAck: 0 };
  return {
    state,
    async getIntent() {
      state.getCalls += 1;
      return { intent: state.intent };
    },
    async acknowledgeIntent({ id }) {
      state.acks.push(id);
      if (state.failAck > 0) {
        state.failAck -= 1;
        throw new Error("bridge gone");
      }
      if (state.intent?.id === id) state.intent = null;
    },
  };
}
const intentAt = (id, createdAt = NOW) => ({
  id,
  url: "buzzweb://call",
  createdAt,
});

test("an intent is handled once and acknowledged exactly once", async () => {
  const source = fakeSource(intentAt("one"));
  const handled = [];
  const consume = createLaunchConsumer({
    source,
    handle: async (intent) => {
      handled.push(intent.id);
    },
    now: () => NOW,
  });
  assert.equal(await consume(), "handled");
  assert.equal(await consume(), "none");
  assert.deepEqual(handled, ["one"]);
  assert.deepEqual(source.state.acks, ["one"]);
});

test("an early acknowledge from the handler is not repeated", async () => {
  const source = fakeSource(intentAt("one"));
  const consume = createLaunchConsumer({
    source,
    handle: async (_intent, acknowledge) => {
      await acknowledge();
      await acknowledge();
    },
    now: () => NOW,
  });
  await consume();
  assert.deepEqual(source.state.acks, ["one"]);
});

test("a failing handler still acknowledges, and never re-dials", async () => {
  const source = fakeSource(intentAt("one"));
  let calls = 0;
  const consume = createLaunchConsumer({
    source,
    handle: async () => {
      calls += 1;
      throw new Error("relay refused");
    },
    now: () => NOW,
  });
  await assert.rejects(consume(), /relay refused/);
  assert.deepEqual(source.state.acks, ["one"]);
  assert.equal(source.state.intent, null);
  assert.equal(await consume(), "none");
  assert.equal(calls, 1);
});

test("a failed acknowledge is retried on the next read without re-handling", async () => {
  const source = fakeSource(intentAt("one"));
  source.state.failAck = 1;
  let calls = 0;
  const consume = createLaunchConsumer({
    source,
    handle: async () => {
      calls += 1;
    },
    now: () => NOW,
  });
  assert.equal(await consume(), "handled");
  assert.equal(source.state.intent?.id, "one");
  assert.equal(await consume(), "none");
  assert.equal(source.state.intent, null);
  assert.equal(calls, 1);
  assert.deepEqual(source.state.acks, ["one", "one"]);
});

test("a stale tap is acknowledged and dropped, never dialed", async () => {
  const source = fakeSource(
    intentAt("old", NOW - LAUNCH_INTENT_MAX_AGE_MS - 1),
  );
  let calls = 0;
  const consume = createLaunchConsumer({
    source,
    handle: async () => {
      calls += 1;
    },
    now: () => NOW,
  });
  assert.equal(await consume(), "stale");
  assert.equal(calls, 0);
  assert.deepEqual(source.state.acks, ["old"]);
});

test("a read during handling is replayed afterwards, not dropped", async () => {
  const source = fakeSource(intentAt("first"));
  const handled = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const consume = createLaunchConsumer({
    source,
    handle: async (intent) => {
      handled.push(intent.id);
      if (intent.id === "first") {
        await gate;
      }
    },
    now: () => NOW,
  });
  const first = consume();
  await new Promise((resolve) => setImmediate(resolve));
  // A second tap lands while the first is still being carried out.
  source.state.intent = intentAt("second");
  assert.equal(await consume(), "busy");
  release();
  assert.equal(await first, "handled");
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(handled, ["first", "second"]);
  assert.deepEqual(source.state.acks, ["first", "second"]);
});

test("freshness rejects old, future and malformed timestamps", () => {
  assert.equal(isLaunchIntentFresh({ createdAt: NOW }, NOW), true);
  assert.equal(
    isLaunchIntentFresh({ createdAt: NOW - LAUNCH_INTENT_MAX_AGE_MS }, NOW),
    true,
  );
  assert.equal(
    isLaunchIntentFresh({ createdAt: NOW - LAUNCH_INTENT_MAX_AGE_MS - 1 }, NOW),
    false,
  );
  assert.equal(isLaunchIntentFresh({ createdAt: NOW + 120_000 }, NOW), false);
  assert.equal(isLaunchIntentFresh({ createdAt: Number.NaN }, NOW), false);
});

test("waitUntil reports readiness, and gives up at the timeout", async () => {
  let ticks = 0;
  const sleep = async () => {
    ticks += 1;
  };
  assert.equal(await waitUntil(() => ticks >= 3, 1000, sleep), true);
  assert.equal(ticks, 3);
  ticks = 0;
  assert.equal(await waitUntil(() => false, 500, sleep), false);
  assert.equal(ticks, 5);
});
