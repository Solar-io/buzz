import assert from "node:assert/strict";
import test from "node:test";

import { timelineMessageFromEvent } from "../../channels/lib/messageBuffer.ts";
import {
  confirmationTemplate,
  confirmationTitle,
  handoffTemplate,
  itemRowTag,
  scratchKickoffTemplate,
  scratchNameFor,
} from "./itemMessages.ts";

const ME = "a".repeat(64);
const SEAT = "b".repeat(64);
const FLIGHT = "10000000-0000-4000-8000-000000000004";
const D = "7f3k2m9qa1bc";

test("the /bug confirmation row carries the item's d, type and coordinate", () => {
  const row = confirmationTemplate({
    channelId: FLIGHT,
    author: ME,
    d: D,
    type: "bug",
    title: "Composer drops the draft",
  });
  assert.equal(row.kind, 9);
  assert.deepEqual(row.tags, [
    ["h", FLIGHT],
    ["a", `30623:${ME}:${D}`],
    ["item", D, "bug"],
  ]);
  assert.equal(row.content, `Filed bug ${D}: Composer drops the draft`);
  assert.equal(
    confirmationTemplate({
      channelId: FLIGHT,
      author: ME,
      d: D,
      type: "backlog",
      title: "T",
    }).content,
    `Added to backlog ${D}: T`,
  );
  // Another client's echo still yields the title.
  assert.equal(confirmationTitle(row.content, D), "Composer drops the draft");
  assert.equal(confirmationTitle("hand-written", D), "hand-written");
});

test("only a well-formed item tag marks a confirmation row", () => {
  assert.deepEqual(itemRowTag([["item", D, "backlog"]]), {
    d: D,
    type: "backlog",
  });
  assert.equal(itemRowTag([["item", D, "task"]]), null);
  assert.equal(itemRowTag([["item", "not-an-id", "bug"]]), null);
  assert.equal(itemRowTag([["a", `30623:${ME}:${D}`]]), null);
  assert.equal(itemRowTag([]), null);
});

test("a timeline message parses the row tag into `item`", () => {
  const event = {
    id: "e".repeat(64),
    pubkey: ME,
    kind: 9,
    created_at: 100,
    sig: "",
    ...confirmationTemplate({
      channelId: FLIGHT,
      author: ME,
      d: D,
      type: "bug",
      title: "T",
    }),
  };
  assert.deepEqual(timelineMessageFromEvent(event).item, { d: D, type: "bug" });
  const plain = { ...event, tags: [["h", FLIGHT]] };
  assert.equal(timelineMessageFromEvent(plain).item, null);
});

test("a handoff is /handoff's shape: @Seat first, the seat's p and handoff tags", () => {
  const one = handoffTemplate({
    channelId: FLIGHT,
    seat: { pubkey: SEAT, name: "Acid Burn" },
    items: [
      { type: "bug", id: D, title: "Composer drops the draft", updatedBy: ME },
    ],
    note: "  ",
  });
  assert.equal(
    one.content,
    `@Acid Burn please take bug ${D}: Composer drops the draft`,
  );
  assert.deepEqual(one.tags, [
    ["h", FLIGHT],
    ["p", SEAT],
    ["handoff", SEAT],
    ["a", `30623:${ME}:${D}`],
  ]);
  const many = handoffTemplate({
    channelId: FLIGHT,
    seat: { pubkey: SEAT, name: "Acid Burn" },
    items: [
      { type: "bug", id: D, title: "One", updatedBy: ME },
      { type: "backlog", id: "0123456789ab", title: "Two", updatedBy: SEAT },
    ],
    note: "Start with the first.",
  });
  assert.equal(
    many.content,
    `@Acid Burn please take these 2 items:\n- bug ${D}: One\n- backlog 0123456789ab: Two\n\nStart with the first.`,
  );
  assert.equal(many.tags.filter((tag) => tag[0] === "a").length, 2);
});

test("a scratch channel for an item is named for it and opens with it", () => {
  const item = {
    type: "bug",
    id: D,
    title: "Composer drops the draft",
    summary: "The draft is discarded.",
    updatedBy: ME,
  };
  assert.equal(scratchNameFor(item), "bug-7f3k2");
  const kickoff = scratchKickoffTemplate({ channelId: FLIGHT, item });
  assert.equal(
    kickoff.content,
    `Scratch channel for bug ${D}: Composer drops the draft\n\nThe draft is discarded.`,
  );
  assert.deepEqual(kickoff.tags, [
    ["h", FLIGHT],
    ["a", `30623:${ME}:${D}`],
  ]);
});
