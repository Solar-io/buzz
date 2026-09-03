import assert from "node:assert/strict";
import { test } from "node:test";
import { queryOnce, unreactToMessage } from "./unreact.ts";

const ME = "aa".repeat(32);
const ALICE = "bb".repeat(32);

function reaction(id, emoji, targetId, pubkey, createdAt = 1000) {
  return {
    id,
    kind: 7,
    content: emoji,
    pubkey,
    tags: [["e", targetId]],
    created_at: createdAt,
    sig: "f".repeat(128),
  };
}

/**
 * A relay stand-in that records what was asked for and what was published.
 * It answers the REQ with `events` then EOSE, on a later tick so the fake
 * exercises the same async path a real socket does.
 */
function fakeSession(events, publishResult = { ok: true, message: "" }) {
  const calls = { filters: [], published: [], closed: 0 };
  return {
    calls,
    subscribe(filters, options) {
      calls.filters.push(filters);
      setTimeout(() => {
        for (const event of events) {
          options.onEvent(event);
        }
        options.onEose?.();
      }, 0);
      return () => {
        calls.closed += 1;
      };
    },
    publish(event) {
      calls.published.push(event);
      return Promise.resolve(publishResult);
    },
  };
}

/** Stand-in signer: stamps an id so the published event is identifiable. */
const fakeSigner = async (template) => ({
  ...template,
  id: "signed",
  pubkey: ME,
  created_at: 5,
  sig: "f".repeat(128),
});

test("queryOnce collects until EOSE and then closes the subscription", async () => {
  const session = fakeSession([reaction("a", "👍", "t", ME)]);
  const events = await queryOnce(session, { kinds: [7] });
  assert.equal(events.length, 1);
  assert.equal(events[0].id, "a");
  assert.equal(session.calls.closed, 1);
});

test("queryOnce resolves empty when the relay never answers", async () => {
  const session = {
    subscribe() {
      return () => {};
    },
  };
  assert.deepEqual(await queryOnce(session, { kinds: [7] }, 5), []);
});

test("unreactToMessage publishes a kind-5 naming the viewer's own kind-7", async () => {
  const session = fakeSession([
    reaction("theirs", "👍", "target", ALICE),
    reaction("mine-other-emoji", "🔥", "target", ME),
    reaction("mine", "👍", "target", ME),
  ]);
  const result = await unreactToMessage(
    session,
    { targetEventId: "target", emoji: "👍", selfPubkey: ME },
    fakeSigner,
  );

  assert.equal(result.ok, true);
  assert.deepEqual(session.calls.filters, [
    { kinds: [7], "#e": ["target"], authors: [ME] },
  ]);
  assert.equal(session.calls.published.length, 1);
  const deletion = session.calls.published[0];
  assert.equal(deletion.kind, 5);
  assert.equal(deletion.content, "");
  // The id must be the REACTION's, never the message's — a kind-5 aimed at
  // "target" would delete the message itself.
  assert.deepEqual(deletion.tags, [["e", "mine"]]);
});

test("unreactToMessage publishes nothing when the viewer has no such reaction", async () => {
  const session = fakeSession([reaction("theirs", "👍", "target", ALICE)]);
  const result = await unreactToMessage(
    session,
    { targetEventId: "target", emoji: "👍", selfPubkey: ME },
    fakeSigner,
  );
  assert.equal(result.ok, false);
  assert.match(result.message, /could not find/i);
  assert.equal(session.calls.published.length, 0);
});

test("unreactToMessage reports a relay rejection instead of throwing", async () => {
  const session = fakeSession([reaction("mine", "👍", "target", ME)], {
    ok: false,
    message: "invalid: must be event author",
  });
  const result = await unreactToMessage(
    session,
    { targetEventId: "target", emoji: "👍", selfPubkey: ME },
    fakeSigner,
  );
  assert.equal(result.ok, false);
  assert.equal(result.message, "invalid: must be event author");
});
