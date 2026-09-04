import assert from "node:assert/strict";
import { test } from "node:test";

import { queryOnce } from "./relayQuery.ts";

function signedEvent(id) {
  return {
    id,
    pubkey: "aa".repeat(32),
    kind: 1,
    created_at: 1,
    content: id,
    tags: [],
    sig: "f".repeat(128),
  };
}

test("queryOnce collects events until EOSE and closes the subscription", async () => {
  let closed = 0;
  const session = {
    subscribe(_filter, options) {
      options.onEvent(signedEvent("a"));
      options.onEvent(signedEvent("b"));
      options.onEose();
      return () => {
        closed += 1;
      };
    },
  };
  const events = await queryOnce(session, { kinds: [1] });
  assert.deepEqual(
    events.map((e) => e.id),
    ["a", "b"],
  );
  // The synchronous EOSE lands before `subscribe` returns its handle, so the
  // close has to be deferred — without that, the subscription leaks.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(closed, 1);
});

test("queryOnce closes an asynchronously-completed subscription exactly once", async () => {
  let closed = 0;
  const session = {
    subscribe(_filter, options) {
      setTimeout(() => {
        options.onEvent(signedEvent("late"));
        options.onEose();
        // A relay that sends EOSE twice must not close twice.
        options.onEose();
      }, 0);
      return () => {
        closed += 1;
      };
    },
  };
  const events = await queryOnce(session, { kinds: [1] });
  assert.deepEqual(
    events.map((e) => e.id),
    ["late"],
  );
  assert.equal(closed, 1);
});

test("queryOnce resolves with a partial result on timeout, not an error", async () => {
  // A slow relay should render a short feed, never an error screen.
  let closed = 0;
  const session = {
    subscribe(_filter, options) {
      options.onEvent(signedEvent("partial"));
      return () => {
        closed += 1;
      };
    },
  };
  const events = await queryOnce(session, { kinds: [1] }, 5);
  assert.deepEqual(
    events.map((e) => e.id),
    ["partial"],
  );
  assert.equal(closed, 1);
});

test("queryOnce passes the filter through untouched", async () => {
  const seen = [];
  const session = {
    subscribe(filter, options) {
      seen.push(filter);
      options.onEose();
      return () => {};
    },
  };
  const filter = { kinds: [30300], authors: ["aa"], limit: 200 };
  await queryOnce(session, filter);
  assert.deepEqual(seen[0], filter);
});
