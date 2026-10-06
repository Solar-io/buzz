import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";

// Architecture review 2026-10-05 ("toast fires, DM row shows no unread").
//
// Drives the TWO real data paths over ONE real RelaySession on a fake wire:
//   - the toast's DM feed: useChannelActivity(dmIds, undefined, self) +
//     onLiveEvent (exactly what MessageToasts registers), and
//   - the sidebar's DM row: useDms(channels, self) -> dmRowUnread(dm, read).
// Then the sidebar's presentation layer (rankSection -> holdOrder ->
// truncateSection) decides whether the unread row is even rendered.

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://web.test/",
});
const originals = {
  window: globalThis.window,
  document: globalThis.document,
  act: globalThis.IS_REACT_ACT_ENVIRONMENT,
};
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// The provider is a boundary: hand the hooks a session the test owns.
globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  "@/shared/api/RelaySessionProvider": `
    export function useRelaySession() {
      return { session: globalThis.__TEST_SESSION__, status: "open" };
    }
  `,
};

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { RelaySession } = await import("../../../shared/api/relay-session.ts");
const { useDms } = await import("../../dms/hooks.ts");
const { useChannelActivity } = await import(
  "../../channels/useChannelActivity.ts"
);
const { dmRowUnread } = await import("./rowUnread.ts");
const { rankSection, holdOrder } = await import("./sectionOrder.ts");
const { truncateSection, SIDEBAR_LIST_OPTIONS } = await import(
  "./sectionList.ts"
);

class FakeSocket {
  constructor() {
    this.sent = [];
    this.listeners = new Map();
    FakeSocket.instances.push(this);
  }
  addEventListener(type, l) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), l]);
  }
  removeEventListener(type, l) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((x) => x !== l),
    );
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.emit("close", {});
  }
  emit(type, event) {
    for (const l of this.listeners.get(type) ?? []) l(event ?? {});
  }
  serverSend(payload) {
    this.emit("message", { data: JSON.stringify(payload) });
  }
}
FakeSocket.instances = [];

const SELF = "a".repeat(64);
const PEER = "b".repeat(64);
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

function dmChannel(id) {
  return {
    id,
    name: "DM",
    type: "dm",
    participantPubkeys: [SELF, PEER],
    updatedAt: 1000,
    archived: false,
    isPrivate: true,
  };
}

function kind9(id, channelId, pubkey, createdAt) {
  return {
    id,
    kind: 9,
    pubkey,
    created_at: createdAt,
    tags: [["h", channelId]],
    content: `msg ${id}`,
    sig: "f".repeat(128),
  };
}

function Probe({ channels, onState, onToast }) {
  const { dms } = useDms(channels, SELF);
  const dmIds = React.useMemo(() => dms.map((d) => d.channel.id), [dms]);
  const toastFeed = useChannelActivity(dmIds, undefined, SELF);
  const register = toastFeed.onLiveEvent;
  React.useEffect(() => register(onToast), [register, onToast]);
  onState(dms);
  return null;
}

async function boot(channels) {
  FakeSocket.instances = [];
  const session = new RelaySession({
    wsUrl: "wss://relay.test",
    webSocketFactory: () => new FakeSocket(),
    signAuthEvent: async (challenge) => ({
      kind: 22242,
      created_at: 1,
      tags: [["challenge", challenge]],
      content: "",
      id: `auth-${challenge}`,
      pubkey: SELF,
      sig: "f".repeat(128),
    }),
    reconnectDelayMs: () => 0,
    authGraceMs: 5,
  });
  globalThis.__TEST_SESSION__ = session;
  const toasts = [];
  let dms = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(Probe, {
        channels,
        onState: (d) => (dms = d),
        onToast: (e) => toasts.push(e),
      }),
    );
  });
  session.connect();
  const socket = FakeSocket.instances[0];
  await act(async () => {
    socket.emit("open");
    socket.serverSend(["AUTH", "c"]);
    await tick(30);
  });
  return {
    session,
    socket,
    root,
    toasts,
    get dms() {
      return dms;
    },
  };
}

after(() => {
  Object.assign(globalThis, {
    window: originals.window,
    document: originals.document,
    IS_REACT_ACT_ENVIRONMENT: originals.act,
  });
  delete globalThis.__BUZZ_TEST_MODULE_STUBS__;
});

test("data path: a live DM arrival reaches BOTH the toast feed and the row's unread state", async () => {
  const id = "dm-1";
  const h = await boot([dmChannel(id)]);
  try {
    const reqs = h.socket.sent.filter((m) => m[0] === "REQ");
    // Identical filters share one wire sub (subscription-share.ts).
    assert.equal(reqs.length, 1, "toast feed and row sampler share one REQ");
    const subId = reqs[0][1];
    await act(async () => {
      h.socket.serverSend(["EVENT", subId, kind9("old", id, PEER, 2000)]);
      h.socket.serverSend(["EOSE", subId]);
      await tick();
    });
    const read = { [id]: 2000 }; // the viewer read up to the old message
    assert.equal(h.dms.length, 1);
    assert.equal(dmRowUnread(h.dms[0], { read, selfPubkey: SELF }), false);
    assert.equal(h.toasts.length, 0, "backfill never toasts");

    await act(async () => {
      h.socket.serverSend(["EVENT", subId, kind9("new", id, PEER, 3000)]);
      await tick();
    });
    assert.equal(h.toasts.length, 1, "the toast fires");
    assert.equal(
      dmRowUnread(h.dms[0], { read, selfPubkey: SELF }),
      true,
      "the row's unread state flips on the same event",
    );
  } finally {
    await act(async () => h.root.unmount());
    h.session.close();
  }
});

test("divergence 1 (marker): a read marker advanced by ANOTHER client clears the row while this client's toast already fired", async () => {
  const id = "dm-1";
  const h = await boot([dmChannel(id)]);
  try {
    const subId = h.socket.sent.find((m) => m[0] === "REQ")[1];
    await act(async () => {
      h.socket.serverSend(["EVENT", subId, kind9("old", id, PEER, 2000)]);
      h.socket.serverSend(["EOSE", subId]);
      h.socket.serverSend(["EVENT", subId, kind9("new", id, PEER, 3000)]);
      await tick();
    });
    assert.equal(h.toasts.length, 1);
    // NIP-RS: a second client that has this DM OPEN marks every arrival seen
    // (repos.tsx markSeen has no visibility/focus gate) and the max-merge
    // lands here ~5 s later.
    const syncedRead = { [id]: 3000 };
    assert.equal(
      dmRowUnread(h.dms[0], { read: syncedRead, selfPubkey: SELF }),
      false,
      "toast shown here, row reads as read: the reported symptom",
    );
  } finally {
    await act(async () => h.root.unmount());
    h.session.close();
  }
});

test("divergence 2 (presentation): pointer-hold + 6-row truncation leave a newly unread DM unrendered", () => {
  // 20 DMs, none unread, none written in: A-Z order. "dm-15" sits at row 16.
  const names = Array.from(
    { length: 20 },
    (_, i) => `peer-${String(i).padStart(2, "0")}`,
  );
  const unreadNow = new Set();
  const facts = (name) => ({
    unread: unreadNow.has(name),
    score: 0,
    lastActivity: 0,
    name,
  });
  const key = (name) => name;
  const before = rankSection(names, key, facts);
  // The pointer is resting on the sidebar (a click on a row, then typing):
  // useHeldKeys captured `before`.
  const heldKeys = before.map(key);

  unreadNow.add("peer-15"); // the toast fires for this DM
  const live = rankSection(names, key, facts);
  assert.equal(
    live[0],
    "peer-15",
    "live ranking lifts the unread DM to the top",
  );

  const rendered = truncateSection({
    items: holdOrder(live, key, heldKeys),
    limit: SIDEBAR_LIST_OPTIONS.visibleItems,
    expanded: false,
  });
  assert.equal(
    rendered.shown.includes("peer-15"),
    false,
    "while held, the unread row stays behind 'N more' — no indicator anywhere (the header dot only shows when COLLAPSED)",
  );
});

test("divergence 3 (two definitions of 'new'): the first message in a never-messaged DM dots the row but never toasts", async () => {
  const id = "dm-fresh";
  const h = await boot([dmChannel(id)]);
  try {
    const subId = h.socket.sent.find((m) => m[0] === "REQ")[1];
    await act(async () => {
      h.socket.serverSend(["EOSE", subId]); // empty history
      h.socket.serverSend(["EVENT", subId, kind9("first", id, PEER, 3000)]);
      await tick();
    });
    // Row: no marker for a DM never opened -> isUnread(..., 0) -> true.
    assert.equal(dmRowUnread(h.dms[0], { read: {}, selfPubkey: SELF }), true);
    // Toast: a live arrival must BEAT a prior sample (channelActivity.ts
    // isLiveArrival); with no sample there is no baseline, so no toast.
    assert.equal(h.toasts.length, 0, "no toast for the first-ever message");
  } finally {
    await act(async () => h.root.unmount());
    h.session.close();
  }
});

// TARGET CONTRACT (fails today; `todo` keeps the suite green until the
// redesign lands — flip to a plain test in phase 1 of the plan).
test("contract: a newly unread conversation is rendered (or its section signals it) even while the order is held", {
  todo: "LEFT_NAV_ARCHITECTURE_REVIEW.md phase 1",
}, () => {
  const names = Array.from(
    { length: 20 },
    (_, i) => `peer-${String(i).padStart(2, "0")}`,
  );
  const unreadNow = new Set();
  const facts = (name) => ({
    unread: unreadNow.has(name),
    score: 0,
    lastActivity: 0,
    name,
  });
  const key = (name) => name;
  const heldKeys = rankSection(names, key, facts).map(key);
  unreadNow.add("peer-15");
  const rendered = truncateSection({
    items: holdOrder(rankSection(names, key, facts), key, heldKeys),
    limit: SIDEBAR_LIST_OPTIONS.visibleItems,
    expanded: false,
  });
  assert.equal(rendered.shown.includes("peer-15"), true);
});
