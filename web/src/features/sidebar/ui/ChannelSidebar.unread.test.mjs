import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  React,
  channel,
  dom,
  moreLabel,
  mountInRail,
  pointerOffNav,
  pointerOnRow,
  sectionRows,
  sidebarProps,
} from "./sidebarJsdom.mjs";

/**
 * I5 and the per-row hold on the REAL rail: unread is never hidden. Sam has
 * ~68 DMs and the DM section shows six; the 10-03 sort keeps a read DM at
 * its A-Z slot, and the old pointer hold froze the whole order while the
 * mouse rested anywhere on the nav — so a DM that turned unread under a
 * resting pointer stayed behind "62 more" with no indicator anywhere
 * (LEFT_NAV_ARCHITECTURE_REVIEW.md, cause B).
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

function railProps(
  { read, dms, profiles },
  { muted = [], unreadCounts = new Map() } = {},
) {
  return sidebarProps({
    lists: { streams: [], forums: [], scratch: [], dms, visibleDms: dms },
    readState: {
      prefs: { favorites: [], muted },
      read,
      activity: new Map(),
      unreadCounts,
    },
    dmIdentity: {
      selfPubkey: SELF,
      profiles,
      presence: new Map(),
      contacts: [],
    },
  });
}

test("I5 + per-row hold: 68 DMs, the one at A-Z position 40 turns unread while the pointer rests on a row: it rises into view with a badge and the pointed-at row does not move", async () => {
  localStorage.clear();
  const quiet = dmFixture(68);
  const view = await mountInRail(
    React.createElement(ChannelSidebar, railProps(quiet)),
  );
  try {
    const before = sectionRows(view.container, "Direct messages");
    assert.equal(before.length, 6, "six rows, the rest behind N more");
    assert.equal(moreLabel(view.container, "Direct messages"), "62 more");

    // The pointer rests on the sixth row (peer-05).
    const pointed = await pointerOnRow(view.container, "Direct messages", 5);
    assert.equal(pointed, name(5));
    await view.rerender(
      React.createElement(
        ChannelSidebar,
        railProps(dmFixture(68, { unread: [40] })),
      ),
    );
    const held = sectionRows(view.container, "Direct messages");
    const row = held.find((r) => r.name === name(40));
    assert.ok(row, "the newly unread DM is rendered under a resting pointer");
    assert.notEqual(row.badge, null, "with its unread badge");
    assert.equal(held[5].name, name(5), "the row under the pointer stays put");
    assert.equal(held[4].name, name(4), "and so does its neighbour");
    assert.equal(held[0].name, name(40), "the unread row rose to the top");

    // The pointer leaves: the live order (peer-03 back in view) returns.
    await pointerOffNav(view.container);
    const live = sectionRows(view.container, "Direct messages");
    assert.deepEqual(
      live.slice(0, 6).map((r) => r.name),
      [name(40), name(0), name(1), name(2), name(3), name(4)],
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

test("I5 under the per-row hold: five DMs turn unread while the pointer pins rows 4-6 — the fifth would land past the slice, and is lifted into view", async () => {
  localStorage.clear();
  const view = await mountInRail(
    React.createElement(ChannelSidebar, railProps(dmFixture(68))),
  );
  try {
    await pointerOnRow(view.container, "Direct messages", 5);
    const unread = [40, 41, 42, 43, 44];
    await view.rerender(
      React.createElement(ChannelSidebar, railProps(dmFixture(68, { unread }))),
    );
    const rows = sectionRows(view.container, "Direct messages");
    assert.equal(rows[5].name, name(5), "the pointed-at row held its place");
    for (const i of unread) {
      const row = rows.find((r) => r.name === name(i));
      assert.ok(row, `${name(i)} is rendered`);
      assert.notEqual(row.badge, null);
    }
  } finally {
    await view.unmount();
  }
});

test("QA #6: a muted DM with a new message shows no pill, is not bold, and is not counted on the phone tab", async () => {
  localStorage.clear();
  const fixture = dmFixture(8, { unread: [2, 5] });
  const view = await mountInRail(
    React.createElement(
      ChannelSidebar,
      railProps(fixture, { muted: [fixture.dms[2].channel.id] }),
    ),
  );
  try {
    const rows = sectionRows(view.container, "Direct messages");
    assert.equal(
      rows.find((r) => r.name === name(2)).badge,
      null,
      "muted: no pill",
    );
    assert.notEqual(
      rows.find((r) => r.name === name(5)).badge,
      null,
      "control: unmuted pill",
    );
    const label = Array.from(
      view.container.querySelectorAll("span.truncate"),
    ).find((el) => el.textContent === name(2));
    assert.equal(label.className.includes("font-semibold"), false, "not bold");
  } finally {
    await view.unmount();
  }
  const { unreadConversationCount } = await import("../lib/rowUnread.ts");
  assert.equal(
    unreadConversationCount([], fixture.dms, {
      prefs: { favorites: [], muted: [fixture.dms[2].channel.id] },
      read: fixture.read,
      activity: new Map(),
      selfPubkey: SELF,
    }),
    1,
    "the phone badge counts only the unmuted unread DM",
  );
});
