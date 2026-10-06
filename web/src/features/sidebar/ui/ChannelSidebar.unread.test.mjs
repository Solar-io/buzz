import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  React,
  channel,
  dom,
  moreLabel,
  mountInRail,
  pointerOnNav,
  sectionRows,
  sidebarProps,
} from "./sidebarJsdom.mjs";

/**
 * I5 on the REAL rail: unread is never hidden. Sam has ~68 DMs and the DM
 * section shows six; the 10-03 sort keeps a read DM at its A-Z slot, and
 * the pointer hold freezes the order while the mouse rests on the nav — so
 * before I5 a DM that turned unread under a resting pointer stayed behind
 * "62 more" with no indicator anywhere (LEFT_NAV_ARCHITECTURE_REVIEW.md,
 * cause B).
 */

const { ChannelSidebar } = await import("./ChannelSidebar.tsx");

after(() => dom.window.close());

const SELF = "a".repeat(64);
const peer = (i) => i.toString(16).padStart(64, "0");
const name = (i) => `peer-${String(i).padStart(2, "0")}`;

function dmFixture(count, { unread = [] } = {}) {
  const read = {};
  const dms = [];
  const profiles = new Map();
  for (let i = 0; i < count; i += 1) {
    const id = `dm-${String(i).padStart(2, "0")}`;
    profiles.set(peer(i), { displayName: name(i) });
    const at = unread.includes(i) ? 5_000 : 1_000;
    read[id] = 1_000;
    dms.push({
      channel: channel(id, `raw-${i}`, "dm", {
        participantPubkeys: [SELF, peer(i)],
      }),
      lastActivity: at,
      lastMessage: {
        channelId: id,
        authorPubkey: peer(i),
        excerpt: "hi",
        created_at: at,
      },
    });
  }
  return { read, dms, profiles };
}

function railProps({ read, dms, profiles }) {
  return sidebarProps({
    lists: { streams: [], forums: [], scratch: [], dms, visibleDms: dms },
    readState: {
      prefs: { favorites: [], muted: [] },
      read,
      activity: new Map(),
      unreadCounts: new Map(),
    },
    dmIdentity: {
      selfPubkey: SELF,
      profiles,
      presence: new Map(),
      contacts: [],
    },
  });
}

test("I5: 68 DMs, the one at A-Z position 40 turns unread while the pointer holds the order: its row renders with a badge", async () => {
  localStorage.clear();
  const quiet = dmFixture(68);
  const view = await mountInRail(
    React.createElement(ChannelSidebar, railProps(quiet)),
  );
  try {
    const before = sectionRows(view.container, "Direct messages");
    assert.equal(before.length, 6, "six rows, the rest behind N more");
    assert.equal(moreLabel(view.container, "Direct messages"), "62 more");

    // The pointer rests on the nav: the order is held from here on.
    await pointerOnNav(view.container);
    await view.rerender(
      React.createElement(
        ChannelSidebar,
        railProps(dmFixture(68, { unread: [40] })),
      ),
    );
    const held = sectionRows(view.container, "Direct messages");
    const row = held.find((r) => r.name === name(40));
    assert.ok(row, "the newly unread DM is rendered while held");
    assert.notEqual(row.badge, null, "with its unread badge");
    assert.deepEqual(
      held.slice(0, 6).map((r) => r.name),
      before.map((r) => r.name),
      "the held rows did not move under the pointer",
    );
  } finally {
    await view.unmount();
  }
});

test("I5: unread rows past the lift cap are counted in the more-row: 'N more · K unread'", async () => {
  localStorage.clear();
  // 30 unread DMs: six fill the slice, twenty are lifted, four remain.
  const unread = Array.from({ length: 30 }, (_, i) => i + 30);
  const view = await mountInRail(
    React.createElement(ChannelSidebar, railProps(dmFixture(68, { unread }))),
  );
  try {
    const rows = sectionRows(view.container, "Direct messages");
    assert.equal(rows.length, 26);
    assert.ok(rows.every((r) => r.badge !== null));
    assert.equal(
      moreLabel(view.container, "Direct messages"),
      "42 more · 4 unread",
    );
  } finally {
    await view.unmount();
  }
});
