import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://web.test/",
});
const originals = {
  window: globalThis.window,
  document: globalThis.document,
  navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
  actEnv: globalThis.IS_REACT_ACT_ENVIRONMENT,
  stubs: globalThis.__BUZZ_TEST_MODULE_STUBS__,
  session: globalThis.__BUZZ_TEST_RELAY_SESSION__,
};
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  "@/shared/api/RelaySessionProvider": `
    export function useRelaySession() {
      return { session: globalThis.__BUZZ_TEST_RELAY_SESSION__ };
    }
  `,
};

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { RelaySession } = await import("@/shared/api/relay-session.ts");
const { useChannelMembers, useChannelMessages } = await import("./hooks.ts");
const { useRouteMentionMembers } = await import(
  "@/features/huddle/useHuddleMentionMembers.ts"
);
const { soleAgent } = await import("./lib/soleAgent.ts");

const ROOM = "membership-room";
const SELF = "a".repeat(64);
const AGENT = "b".repeat(64);
const KNOWN_AGENTS = new Set([AGENT]);
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

class FakeSocket {
  sent = [];
  listeners = new Map();
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type, listener) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((item) => item !== listener),
    );
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.emit("close", {});
  }
  emit(type, event) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  serverSend(frame) {
    this.emit("message", { data: JSON.stringify(frame) });
  }
  activeRequests() {
    const requests = new Map();
    for (const frame of this.sent) {
      if (frame[0] === "REQ") requests.set(frame[1], frame);
      if (frame[0] === "CLOSE") requests.delete(frame[1]);
    }
    return [...requests.values()];
  }
  requestFor(kind) {
    return this.activeRequests().find((frame) =>
      frame.slice(2).some((filter) => filter.kinds?.includes(kind)),
    );
  }
  rosterRequests() {
    return this.sent.filter(
      (frame) => frame[0] === "REQ" && frame[2].kinds?.includes(39002),
    );
  }
}

function snapshot(pubkeys, createdAt = 100, channelId = ROOM) {
  return {
    id: `${channelId}-roster-${createdAt}-${pubkeys.length}`,
    kind: 39002,
    pubkey: "c".repeat(64),
    created_at: createdAt,
    tags: [["d", channelId], ...pubkeys.map((pubkey) => ["p", pubkey])],
    content: "",
    sig: "f".repeat(128),
  };
}

function notice(type, channelId = ROOM) {
  return {
    id: `${channelId}-${type}`,
    kind: 40099,
    pubkey: "c".repeat(64),
    created_at: Math.floor(Date.now() / 1000),
    tags: [["h", channelId]],
    content: JSON.stringify({ type, target: AGENT }),
    sig: "f".repeat(128),
  };
}

async function withRoster(run, { timeline = false } = {}) {
  const socket = new FakeSocket();
  const session = new RelaySession({
    wsUrl: "wss://relay.test",
    webSocketFactory: () => socket,
    signAuthEvent: async () => snapshot([]),
    livenessIntervalMs: 0,
    subscriptionHealthIntervalMs: 0,
  });
  globalThis.__BUZZ_TEST_RELAY_SESSION__ = session;
  let latest;
  function Standalone() {
    latest = { members: useChannelMembers(ROOM) };
    return null;
  }
  function Conversation() {
    const { messages } = useChannelMessages(ROOM);
    const { members } = useRouteMentionMembers(
      { id: ROOM, type: "stream" },
      SELF,
      { channelId: null, memberPubkeys: [], memberRosterKnown: false },
      messages,
    );
    latest = {
      members,
      agent: soleAgent(
        members.map((member) => member.pubkey),
        SELF,
        KNOWN_AGENTS,
      ),
    };
    return React.createElement("div", null, latest.agent ?? "no agent");
  }
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  const deliver = async (kind, event) => {
    const request = socket.requestFor(kind);
    assert.ok(request, `a real wire REQ subscribes to kind ${kind}`);
    await act(async () => {
      socket.serverSend(["EVENT", request[1], event]);
      await tick();
    });
  };
  try {
    await act(async () => {
      root.render(React.createElement(timeline ? Conversation : Standalone));
      await tick();
    });
    await act(async () => {
      session.connect();
      socket.emit("open", {});
      socket.serverSend(["AUTH", "challenge"]);
      await tick();
    });
    assert.equal(
      socket.rosterRequests().length,
      1,
      "initial roster is fetched",
    );
    await run({ socket, deliver, latest: () => latest, container });
  } finally {
    await act(async () => root.unmount());
    assert.equal(socket.activeRequests().length, 0, "all subscriptions close");
    session.close();
    container.remove();
  }
}

test("member_joined refetches the roster and adds the new agent", async () => {
  await withRoster(async ({ socket, deliver, latest }) => {
    await deliver(39002, snapshot([SELF]));
    const request = socket.requestFor(39002);
    socket.serverSend(["EOSE", request[1]]);
    const membershipFilter = socket.requestFor(40099)?.[2];
    assert.deepEqual(membershipFilter?.["#h"], [ROOM]);
    assert.ok(Math.abs(membershipFilter.since - Date.now() / 1000) < 2);
    await deliver(40099, notice("member_joined"));
    assert.equal(socket.rosterRequests().length, 2, "join opens a fresh REQ");
    await deliver(39002, snapshot([SELF, AGENT], 101));
    assert.deepEqual(
      latest().members.map((member) => member.pubkey),
      [SELF, AGENT],
    );
  });
});

for (const type of ["member_left", "member_removed"]) {
  test(`${type} refetches and removes a pubkey absent from the newest roster`, async () => {
    await withRoster(async ({ socket, deliver, latest }) => {
      await deliver(39002, snapshot([SELF, AGENT]));
      await deliver(40099, notice(type));
      assert.equal(socket.rosterRequests().length, 2);
      await deliver(39002, snapshot([SELF], 101));
      assert.deepEqual(
        latest().members.map((member) => member.pubkey),
        [SELF],
      );
    });
  });
}

test("initial roster replaces snapshots and ignores older out-of-order events", async () => {
  await withRoster(async ({ deliver, latest }) => {
    await deliver(39002, snapshot([SELF, AGENT], 99));
    await deliver(39002, snapshot([SELF], 101));
    await deliver(39002, snapshot([SELF, AGENT], 100));
    assert.deepEqual(latest().members, [
      { pubkey: SELF, name: "aaaaaaaa…aaaa" },
    ]);
    await deliver(39002, snapshot([], 102));
    assert.deepEqual(latest().members, []);
  });
});

test("malformed, unrelated and wrong-channel notices do not refetch", async () => {
  await withRoster(async ({ socket, deliver }) => {
    await deliver(40099, notice("topic_changed"));
    await deliver(40099, { ...notice("member_joined"), content: "not JSON" });
    await deliver(40099, notice("member_joined", "other-room"));
    await deliver(39002, snapshot([AGENT], 200, "other-room"));
    assert.equal(socket.rosterRequests().length, 1);
  });
});

test("a closed roster request cannot overwrite a newer refresh", async () => {
  await withRoster(async ({ socket, deliver, latest }) => {
    await deliver(39002, snapshot([SELF]));
    const oldRequest = socket.requestFor(39002);
    await deliver(40099, notice("member_joined"));
    await deliver(39002, snapshot([SELF, AGENT], 101));
    await act(async () => {
      socket.serverSend(["EVENT", oldRequest[1], snapshot([], 200)]);
    });
    assert.deepEqual(
      latest().members.map((member) => member.pubkey),
      [SELF, AGENT],
    );
  });
});

test("composer soleAgent sees a joined agent through the existing timeline subscription", async () => {
  await withRoster(
    async ({ socket, deliver, latest, container }) => {
      await deliver(39002, snapshot([SELF]));
      assert.equal(latest().agent, null);
      assert.equal(
        socket
          .activeRequests()
          .filter((frame) =>
            frame.slice(2).some((filter) => filter.kinds?.includes(40099)),
          ).length,
        1,
        "the roster reuses the timeline's system-message REQ",
      );
      const before = socket.rosterRequests().length;
      await deliver(40099, notice("member_joined"));
      assert.equal(socket.rosterRequests().length, before + 1);
      await deliver(39002, snapshot([SELF, AGENT], 101));
      assert.equal(latest().agent, AGENT);
      assert.equal(container.textContent, AGENT);
      // Replayed notices must not create a refresh loop.
      await deliver(40099, notice("member_joined"));
      assert.equal(socket.rosterRequests().length, before + 1);
      await deliver(40099, notice("member_removed"));
      await deliver(39002, snapshot([SELF], 102));
      assert.equal(latest().agent, null);
    },
    { timeline: true },
  );
});

after(() => {
  globalThis.window = originals.window;
  globalThis.document = originals.document;
  if (originals.navigator)
    Object.defineProperty(globalThis, "navigator", originals.navigator);
  globalThis.IS_REACT_ACT_ENVIRONMENT = originals.actEnv;
  globalThis.__BUZZ_TEST_MODULE_STUBS__ = originals.stubs;
  globalThis.__BUZZ_TEST_RELAY_SESSION__ = originals.session;
  dom.window.close();
});
