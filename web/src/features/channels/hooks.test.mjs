import assert from "node:assert/strict";
import { test, after } from "node:test";

// useProfiles reads the relay session through <RelaySessionProvider>'s
// context, and the real provider builds its own session around a live
// WebSocket. The boundary is stubbed here (module stub resolved by
// web/test-loader-hooks.mjs) so the hook runs against a REAL RelaySession
// driven by a scripted fake socket — the same injection seam
// relay-session.test.mjs uses. The stub must exist before hooks.ts's module
// graph resolves, hence the ordering below.
const { JSDOM } = await import("jsdom");
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

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");

globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  "@/shared/api/RelaySessionProvider": `
    export function useRelaySession() {
      const session = globalThis.__BUZZ_TEST_RELAY_SESSION__;
      if (!session) {
        throw new Error("test did not install a relay session");
      }
      return { session, status: "open" };
    }
    export function RelaySessionProvider({ children }) {
      return children ?? null;
    }
  `,
};

const { RelaySession } = await import("@/shared/api/relay-session.ts");
const { useProfiles } = await import("./hooks.ts");

// --- FakeSocket: copied from relay-session.test.mjs (same wire dance) ------

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.listeners = new Map();
    this.closed = false;
    FakeSocket.instances.push(this);
  }
  addEventListener(type, listener) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  removeEventListener(type, listener) {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((l) => l !== listener),
    );
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
    this.emit("close", {});
  }
  emit(type, event) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event ?? {});
    }
  }
  serverSend(payload) {
    this.emit("message", { data: JSON.stringify(payload) });
  }
  sentOf(type) {
    return this.sent.filter((m) => m[0] === type);
  }
}
FakeSocket.instances = [];

function fakeAuthEvent(challenge) {
  return {
    kind: 22242,
    created_at: 1_700_000_000,
    tags: [["challenge", challenge]],
    content: "",
    id: `auth-${challenge}`,
    pubkey: "aa".repeat(32),
    sig: "ff".repeat(64),
  };
}

function tick(ms = 10) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Install a fresh RelaySession for the provider stub to hand the hook. */
function startSession() {
  FakeSocket.instances = [];
  const session = new RelaySession({
    wsUrl: "wss://relay.test",
    webSocketFactory: (url) => new FakeSocket(url),
    signAuthEvent: async (challenge) => fakeAuthEvent(challenge),
    reconnectDelayMs: () => 0,
    authGraceMs: 5,
  });
  globalThis.__BUZZ_TEST_RELAY_SESSION__ = session;
  return session;
}

/** Mount a probe that records the profiles map on every render. */
async function mountProbe(pubkeys) {
  const seen = [];
  function Probe() {
    seen.push(useProfiles(pubkeys));
    return null;
  }
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(Probe));
  });
  return {
    seen,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/** Open the socket and complete the AUTH dance so queued REQs go out. */
async function connectAndOpen(session) {
  session.connect();
  const socket = FakeSocket.instances.at(-1);
  socket.emit("open");
  socket.serverSend(["AUTH", "chal"]);
  await tick();
  return socket;
}

function kind0(pubkey, createdAt, picture, name = "Grumpy") {
  return {
    id: `ev-${pubkey.slice(0, 8)}-${createdAt}`,
    kind: 0,
    pubkey,
    created_at: createdAt,
    tags: [],
    content: JSON.stringify({ name, picture }),
    sig: "00",
  };
}

const PUBKEY = "a".repeat(64);

/**
 * Fresh session + mounted probe per test. try/finally is load-bearing: an
 * assertion must still unmount the React root and close the socket, or the
 * leaked handles hang the per-file runner child.
 */
async function withProfileSession(seed, run) {
  dom.window.localStorage.setItem("profiles:v1", JSON.stringify(seed ?? {}));
  const session = startSession();
  const probe = await mountProbe([PUBKEY]);
  try {
    const socket = await connectAndOpen(session);
    const subId = socket.sentOf("REQ")[0][1];
    await run({ probe, socket, subId });
  } finally {
    await probe.unmount();
    session.close();
  }
}

test("a newer kind-0 replaces an older stored profile (newer arrives first)", async () => {
  await withProfileSession(null, async ({ probe, socket, subId }) => {
    await act(async () => {
      socket.serverSend([
        "EVENT",
        subId,
        kind0(PUBKEY, 200, "https://pic/new"),
      ]);
      socket.serverSend([
        "EVENT",
        subId,
        kind0(PUBKEY, 100, "https://pic/old"),
      ]);
    });
    assert.equal(probe.seen.at(-1).get(PUBKEY)?.avatar, "https://pic/new");
    assert.equal(probe.seen.at(-1).get(PUBKEY)?.updatedAt, 200);
  });
});

test("a newer kind-0 replaces an older stored profile (older arrives first)", async () => {
  // Relay replay order is not guaranteed (reconnect backfill can deliver the
  // stale row last), so both orders must land on the newest picture.
  await withProfileSession(null, async ({ probe, socket, subId }) => {
    await act(async () => {
      socket.serverSend([
        "EVENT",
        subId,
        kind0(PUBKEY, 100, "https://pic/old"),
      ]);
      socket.serverSend([
        "EVENT",
        subId,
        kind0(PUBKEY, 200, "https://pic/new"),
      ]);
    });
    assert.equal(probe.seen.at(-1).get(PUBKEY)?.avatar, "https://pic/new");
    assert.equal(probe.seen.at(-1).get(PUBKEY)?.updatedAt, 200);
  });
});

test("a seeded stale profile loses to any real kind-0 event", async () => {
  // The localStorage seed re-supplies the last-rendered profile across
  // reloads; whatever its age, a freshly delivered event must outrank it.
  await withProfileSession(
    {
      [PUBKEY]: {
        name: "StaleName",
        displayName: "StaleName",
        avatar: "https://pic/seeded",
        updatedAt: 50,
      },
    },
    async ({ probe, socket, subId }) => {
      // The seed paints the first frame…
      assert.equal(probe.seen[0].get(PUBKEY)?.avatar, "https://pic/seeded");
      await act(async () => {
        socket.serverSend([
          "EVENT",
          subId,
          kind0(PUBKEY, 100, "https://pic/live"),
        ]);
      });
      assert.equal(probe.seen.at(-1).get(PUBKEY)?.avatar, "https://pic/live");
      assert.equal(probe.seen.at(-1).get(PUBKEY)?.updatedAt, 100);
    },
  );
});

test("a seeded fresh profile survives a re-delivered older event", async () => {
  // Reconnect replay re-REQs from scratch, so the pre-reload profile can
  // arrive again with its OLD created_at — it must not clobber the seed.
  await withProfileSession(
    {
      [PUBKEY]: {
        name: "FreshName",
        displayName: "FreshName",
        avatar: "https://pic/current",
        updatedAt: 500,
      },
    },
    async ({ probe, socket, subId }) => {
      await act(async () => {
        socket.serverSend([
          "EVENT",
          subId,
          kind0(PUBKEY, 100, "https://pic/stale-replay", "OldName"),
        ]);
      });
      assert.equal(
        probe.seen.at(-1).get(PUBKEY)?.avatar,
        "https://pic/current",
      );
      assert.equal(probe.seen.at(-1).get(PUBKEY)?.updatedAt, 500);
    },
  );
});

// Restore process globals after this file's tests finish (the runner keeps
// one process for the whole suite; a leaked window/document would bleed into
// other files).
after(() => {
  Object.assign(globalThis, {
    window: originals.window,
    document: originals.document,
    IS_REACT_ACT_ENVIRONMENT: originals.actEnv,
    __BUZZ_TEST_MODULE_STUBS__: originals.stubs,
    __BUZZ_TEST_RELAY_SESSION__: originals.session,
  });
  if (originals.navigator) {
    Object.defineProperty(globalThis, "navigator", originals.navigator);
  }
});

