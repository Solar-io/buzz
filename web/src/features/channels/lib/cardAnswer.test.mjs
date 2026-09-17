import assert from "node:assert/strict";
import { test } from "node:test";
import { sendCardAnswer } from "./cardAnswer.ts";
import { message } from "@/features/home/lib/inboxFixtures.mjs";

// A plain fake session: sendCardAnswer must hand the signed event to
// publish() and pass the {ok, message} verdict through untouched.
function fakeSession() {
  const calls = [];
  return {
    calls,
    async publish(event) {
      calls.push(event);
      return { ok: true, message: "" };
    },
  };
}

const card = message({
  id: "card-1",
  channelId: "ch-1",
  authorPubkey: "bb".repeat(32),
  kind: 9,
  rootId: null,
  replyToId: null,
  card: { title: "Ship?", options: [{ id: "0", label: "Yes" }] },
});

test("a top-level card's answer e-tags the card as its own root", async () => {
  const session = fakeSession();
  const result = await sendCardAnswer(session, card, "  Yes  ");
  assert.equal(result.ok, true);
  assert.equal(session.calls.length, 1);
  const event = session.calls[0];
  assert.equal(event.kind, 9);
  // One e tag: root === reply target, so the builder collapses to a single
  // reply marker naming the CARD — that marker is what answer detection reads.
  const eTags = event.tags.filter((t) => t[0] === "e");
  assert.deepEqual(eTags, [["e", "card-1", "", "reply"]]);
  assert.deepEqual(
    event.tags.filter((t) => t[0] === "p"),
    [["p", "bb".repeat(32)]],
  );
  assert.deepEqual(
    event.tags.filter((t) => t[0] === "h"),
    [["h", "ch-1"]],
  );
  assert.equal(event.content, "Yes");
});

test("a card that is itself a reply keeps ITS thread root", async () => {
  // The relay rejects a self-rooted reply ("root tag does not match thread
  // ancestry", caught live 9/16) — the root must be the card's root.
  const session = fakeSession();
  const nested = { ...card, rootId: "thread-root-1", replyToId: "parent-1" };
  await sendCardAnswer(session, nested, "No");
  const eTags = session.calls[0].tags.filter((t) => t[0] === "e");
  assert.deepEqual(eTags, [
    ["e", "thread-root-1", "", "root"],
    ["e", "card-1", "", "reply"],
  ]);
});

test("the relay verdict passes through untouched, ok:false included", async () => {
  // publish() RESOLVES {ok:false} on rejection — it does not throw. The
  // helper must not swallow or reshape that verdict.
  const session = {
    async publish() {
      return { ok: false, message: "relay refused" };
    },
  };
  const result = await sendCardAnswer(session, card, "Yes");
  assert.deepEqual(result, { ok: false, message: "relay refused" });
});
