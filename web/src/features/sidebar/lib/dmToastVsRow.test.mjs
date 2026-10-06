import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  React,
  act,
  channel,
  dom,
  mountInRail,
  pointerOnRow,
  sectionRows,
  sidebarProps,
} from "../ui/sidebarJsdom.mjs";

// Architecture review 2026-10-05 ("toast fires, DM row shows no unread"),
// re-pointed at the redesign (LEFT_NAV_ARCHITECTURE_REVIEW.md §3).
//
// The shell's REAL wiring, end to end on one real RelaySession over a fake
// wire: useShellConversationActivity (the one feed), MessageToasts (the
// toast, registered on that store) and ChannelSidebar (the rows and pills,
// rendered from that store) — exactly what repos.tsx mounts. Then the
// presentation layer's I5 contract on the pure functions.

const { RelaySession } = await import("../../../shared/api/relay-session.ts");
const { useShellConversationActivity } = await import(
  "../../activity/useConversationActivity.ts"
);
const { MessageToasts } = await import("../../channels/ui/MessageToasts.tsx");
const { ChannelSidebar } = await import("../ui/ChannelSidebar.tsx");
const { dmRowUnread } = await import("./rowUnread.ts");
const { rankSection, holdOrder } = await import("./sectionOrder.ts");
const { truncateSection, SIDEBAR_LIST_OPTIONS } = await import(
  "./sectionList.ts"
);
const { clearUnreadTrace, readUnreadTrace } = await import(
  "../../activity/unreadTrace.ts"
);
const {
  applyRemoteMarkers,
  getChannelMarkers,
  getInboxMarkers,
  markSeen,
  resetReadMarkersForTests,
} = await import("../../activity/readMarkers.ts");
const { useChannelMarkers } = await import("../../activity/useReadMarkers.ts");

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
const peer = (i) => (i + 1).toString(16).padStart(64, "0");
const peerName = (i) => `peer-${String(i).padStart(2, "0")}`;
const dmId = (i) => `dm-${String(i).padStart(2, "0")}`;
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const PREFS = { favorites: [], muted: [] };

function dmChannels(count) {
  return Array.from({ length: count }, (_, i) =>
    channel(dmId(i), `raw-${i}`, "dm", {
      participantPubkeys: [SELF, peer(i)],
    }),
  );
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

/** What repos.tsx mounts, minus everything unrelated to unread. */
function Shell({ channels, profiles, onFrame }) {
  const session = globalThis.__BUZZ_TEST_RELAY_SESSION__;
  // THE read-marker store, as repos.tsx reads it (phase 2).
  const read = useChannelMarkers();
  const { store, state, dms } = useShellConversationActivity({
    session,
    channels,
    selfPubkey: SELF,
    readMarkers: read,
  });
  onFrame({ store, dms });
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(MessageToasts, {
      selfPubkey: SELF,
      selectedId: null,
      channels,
      onArrival: store.onArrival,
      channelPrefs: PREFS,
      profiles,
      onOpenChannel: () => {},
    }),
    React.createElement(
      ChannelSidebar,
      sidebarProps({
        lists: { streams: [], forums: [], scratch: [], dms, visibleDms: dms },
        readState: {
          prefs: PREFS,
          read,
          activity: state.activity,
          unreadCounts: state.unreadCounts,
        },
        dmIdentity: {
          selfPubkey: SELF,
          profiles,
          presence: new Map(),
          contacts: [],
        },
      }),
    ),
  );
}

async function boot({ channels, read }) {
  FakeSocket.instances = [];
  localStorage.clear();
  localStorage.setItem("buzz.read-state.v1", JSON.stringify(read));
  resetReadMarkersForTests();
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
  globalThis.__BUZZ_TEST_RELAY_SESSION__ = session;
  const profiles = new Map(
    channels.map((_, i) => [peer(i), { displayName: peerName(i) }]),
  );
  const frame = { current: null };
  const toasts = [];
  globalThis.__BUZZ_TEST_ON_TOAST__ = (spec) => {
    // I1, checked AT the moment the toast is raised: the store already
    // holds the arrival, so the row it feeds is unread right now.
    const { store, dms } = frame.current;
    const activity = store.getSnapshot().activity;
    const rowUnreadNow = dms.map((dm) =>
      dmRowUnread(
        {
          ...dm,
          lastMessage: activity.has(dm.channel.id)
            ? {
                authorPubkey: activity.get(dm.channel.id).pubkey,
                created_at: activity.get(dm.channel.id).createdAt,
              }
            : null,
        },
        { read: getChannelMarkers(), selfPubkey: SELF },
      ),
    );
    toasts.push({
      spec,
      unreadRowsAtToast: rowUnreadNow.filter(Boolean).length,
    });
  };
  const element = () =>
    React.createElement(Shell, {
      channels,
      profiles,
      onFrame: (f) => {
        frame.current = f;
      },
    });
  const view = await mountInRail(element());
  session.connect();
  const socket = FakeSocket.instances[0];
  await act(async () => {
    socket.emit("open");
    socket.serverSend(["AUTH", "c"]);
    await tick(30);
  });
  /** The kind-9 activity REQs on the wire (one per batch). */
  const activityReqs = () =>
    socket.sent.filter(
      (m) => m[0] === "REQ" && m.slice(2).every((f) => f.kinds?.[0] === 9),
    );
  /** Deliver to whichever activity batch carries `channelId`. */
  const subFor = (channelId) =>
    activityReqs().find((m) =>
      m.slice(2).some((f) => f["#h"]?.includes(channelId)),
    )[1];
  // The session opens REQs a window at a time (post-AUTH replay), so keep
  // answering until no new batch appears.
  const eoseAll = async () => {
    const answered = new Set();
    for (;;) {
      const pending = activityReqs().filter((m) => !answered.has(m[1]));
      if (pending.length === 0) return;
      await act(async () => {
        for (const req of pending) {
          answered.add(req[1]);
          socket.serverSend(["EOSE", req[1]]);
        }
        await tick();
      });
    }
  };
  const deliver = async (event) =>
    act(async () => {
      socket.serverSend(["EVENT", subFor(event.tags[0][1]), event]);
      await tick();
    });
  return {
    session,
    socket,
    view,
    toasts,
    activityReqs,
    eoseAll,
    deliver,
    rows: () => sectionRows(view.container, "Direct messages"),
    async close() {
      await view.unmount();
      session.close();
      delete globalThis.__BUZZ_TEST_ON_TOAST__;
    },
  };
}

after(() => dom.window.close());

test("I1 toast ⇒ row: a live DM arrival under a resting pointer toasts, and in that same commit its row is unread and rendered with pill 1, then 2", async () => {
  const channels = dmChannels(20);
  const read = Object.fromEntries(channels.map((c) => [c.id, 1_000]));
  const h = await boot({ channels, read });
  try {
    await h.eoseAll();
    assert.equal(h.rows().length, 6, "twenty read DMs: six rows shown");
    assert.equal(
      h.rows().some((r) => r.name === peerName(15)),
      false,
      "peer-15 starts behind 'N more' (A-Z slot 16)",
    );
    // The mouse rests on the sidebar from here on.
    await pointerOnRow(h.view.container, "Direct messages", 2);

    clearUnreadTrace();
    await h.deliver(kind9("m1", dmId(15), peer(15), 2_000));
    assert.equal(h.toasts.length, 1, "the toast fires");
    assert.equal(
      h.toasts[0].unreadRowsAtToast,
      1,
      "the row was already unread when the toast was raised",
    );
    const row = h.rows().find((r) => r.name === peerName(15));
    assert.ok(row, "the toasted DM's row is rendered (I5 under the hold)");
    assert.equal(row.badge, "1", "pill 1 from the store's count (I4)");
    const [arrival] = readUnreadTrace().filter((e) => e.type === "arrival");
    assert.equal(arrival.toasted, true);
    assert.equal(arrival.rowUnread, true, "the trace agrees");

    await h.deliver(kind9("m2", dmId(15), peer(15), 2_001));
    assert.equal(h.toasts.length, 2);
    assert.equal(
      h.rows().find((r) => r.name === peerName(15)).badge,
      "2",
      "a second message makes it 2",
    );
  } finally {
    await h.close();
  }
});

test("I2: the first message in a never-messaged DM both toasts and dots (was divergence 3)", async () => {
  const channels = dmChannels(1);
  const h = await boot({ channels, read: {} });
  try {
    await h.eoseAll(); // empty history
    await h.deliver(kind9("first", dmId(0), peer(0), 3_000));
    assert.equal(h.toasts.length, 1, "the first-ever message toasts");
    assert.equal(h.rows()[0].badge, "1", "and its row shows pill 1");
  } finally {
    await h.close();
  }
});

test("I1: backfill never toasts, and an own message never toasts or dots", async () => {
  const channels = dmChannels(2);
  const h = await boot({ channels, read: { [dmId(0)]: 1_000 } });
  try {
    await h.deliver(kind9("old", dmId(0), peer(0), 1_500));
    await h.eoseAll();
    assert.equal(h.toasts.length, 0, "backfill: no toast");
    assert.equal(h.rows().find((r) => r.name === peerName(0)).badge, "1");
    await h.deliver(kind9("mine", dmId(1), SELF, 4_000));
    assert.equal(h.toasts.length, 0, "own message: no toast");
    assert.equal(h.rows().find((r) => r.name === peerName(1)).badge, null);
  } finally {
    await h.close();
  }
});

test("phase 1 AC: one REQ family — 68 DMs open 7 activity batches, not one per row or per twin feed", async () => {
  const channels = [
    ...dmChannels(68),
    ...Array.from({ length: 5 }, (_, i) => channel(`ch-${i}`, `chan-${i}`)),
  ];
  const h = await boot({ channels, read: {} });
  try {
    await h.eoseAll();
    const reqs = h.activityReqs();
    const dmBatches = reqs.filter((m) =>
      m.slice(2).every((f) => f["#h"][0].startsWith("dm-")),
    );
    assert.equal(dmBatches.length, 7, "ceil(68 / 10) DM batches");
    assert.equal(reqs.length, 8, "plus one batch for the five channels");
    // No one-shot per-row count REQs, no twin toast feed: every kind-9
    // filter on the wire belongs to the family.
    const allKind9 = h.socket.sent.filter(
      (m) => m[0] === "REQ" && m.slice(2).some((f) => f.kinds?.includes(9)),
    );
    assert.equal(allKind9.length, reqs.length);
  } finally {
    await h.close();
  }
});

test("phase 2 / I1 clear: an NIP-RS merge clears the toasted row by re-rendering through the store (no window event), and the clear is a traced markerMoved naming the install", async () => {
  const channels = dmChannels(3);
  const read = Object.fromEntries(channels.map((c) => [c.id, 1_000]));
  const h = await boot({ channels, read });
  const events = [];
  const realDispatch = window.dispatchEvent.bind(window);
  window.dispatchEvent = (event) => {
    events.push(event.type);
    return realDispatch(event);
  };
  try {
    await h.eoseAll();
    await h.deliver(kind9("m1", dmId(1), peer(1), 2_000));
    assert.equal(h.toasts.length, 1);
    assert.equal(h.rows().find((r) => r.name === peerName(1)).badge, "1");

    clearUnreadTrace();
    // What readStateSync does with another device's blob: max-merge into
    // the store. Nothing else is called — no event, no re-read.
    await act(async () => {
      applyRemoteMarkers(
        {
          channels: { ...getChannelMarkers(), [dmId(1)]: 2_000 },
          inbox: getInboxMarkers(),
        },
        { [dmId(1)]: "sync:cccccccc/phone1" },
      );
    });
    assert.equal(
      h.rows().find((r) => r.name === peerName(1)).badge,
      null,
      "the row re-rendered as read",
    );
    assert.deepEqual(events, [], "no window event carried it");
    const [move] = readUnreadTrace().filter((e) => e.type === "markerMoved");
    assert.equal(move.id, dmId(1));
    assert.equal(move.source, "sync:cccccccc/phone1");
    assert.ok(move.to >= 2_000, "the clear covers the toasted message (I1)");
  } finally {
    window.dispatchEvent = realDispatch;
    await h.close();
  }
});

test("phase 2: a local mark (opening the DM) clears its pill through the same store and is traced as 'open'", async () => {
  const channels = dmChannels(2);
  const read = Object.fromEntries(channels.map((c) => [c.id, 1_000]));
  const h = await boot({ channels, read });
  try {
    await h.eoseAll();
    await h.deliver(kind9("m1", dmId(0), peer(0), 2_000));
    await h.deliver(kind9("m2", dmId(0), peer(0), 2_001));
    assert.equal(h.rows().find((r) => r.name === peerName(0)).badge, "2");
    clearUnreadTrace();
    await act(async () => {
      markSeen(dmId(0), 2_001, "open");
    });
    assert.equal(h.rows().find((r) => r.name === peerName(0)).badge, null);
    assert.equal(readUnreadTrace()[0].source, "open");
  } finally {
    await h.close();
  }
});

// ---- presentation (I5) on the pure pipeline ------------------------------

test("divergence 2 (presentation, pre-I5 pipeline): pointer-hold + 6-row truncation WITHOUT the unread predicate leave a newly unread DM unrendered", () => {
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
    "without the predicate the unread row stays behind 'N more' — why SidebarSection must pass isUnread",
  );
});

// TARGET CONTRACT (I5) — a `todo` until phase 0 landed: the section's
// unread predicate (what SidebarSection hands truncateSection) lifts the row.
test("contract: a newly unread conversation is rendered (or its section signals it) even while the order is held", () => {
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
    isUnread: (name) => unreadNow.has(name),
  });
  assert.equal(rendered.shown.includes("peer-15"), true);
});
