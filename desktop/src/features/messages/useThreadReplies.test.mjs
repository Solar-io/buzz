import assert from "node:assert/strict";
import test from "node:test";

import {
  THREAD_PAGE_LIMIT,
  THREAD_REPLIES_STALE_TIME_MS,
  backfillThreadAux,
  collectThreadAuxMessageIds,
  loadThreadReplies,
} from "./useThreadReplies.ts";
import { threadRepliesKey } from "./lib/messageQueryKeys.ts";

const ROOT_ID = "1".repeat(64);
const REPLY_ID = "2".repeat(64);
const CHANNEL_ID = "36411e44-0e2d-4cfe-bd6e-567eb169db9f";

function reply(id = REPLY_ID) {
  return {
    id,
    pubkey: "a".repeat(64),
    kind: 9,
    created_at: 1_700_000_000,
    content: "reply",
    tags: [["e", ROOT_ID]],
    sig: "sig",
  };
}

function makeQueryClientStub(initialEvents = []) {
  const store = new Map([
    [JSON.stringify(threadRepliesKey(CHANNEL_ID, ROOT_ID)), initialEvents],
  ]);
  return {
    getQueryData(key) {
      return store.get(JSON.stringify(key));
    },
    setQueryData(key, updater) {
      const k = JSON.stringify(key);
      const next =
        typeof updater === "function" ? updater(store.get(k) ?? []) : updater;
      store.set(k, next);
      return next;
    },
  };
}

test("thread aux hydration includes the root when there are no replies", () => {
  assert.deepEqual(collectThreadAuxMessageIds(ROOT_ID, []), [ROOT_ID]);
});

test("thread aux hydration includes and deduplicates root and reply ids", () => {
  assert.deepEqual(
    collectThreadAuxMessageIds(ROOT_ID, [reply(), reply(ROOT_ID)]),
    [ROOT_ID, REPLY_ID],
  );
});

test("page limit uses the server-clamped 500 maximum and staleTime is bounded", () => {
  assert.equal(THREAD_PAGE_LIMIT, 500);
  assert.ok(
    THREAD_REPLIES_STALE_TIME_MS > 0 &&
      Number.isFinite(THREAD_REPLIES_STALE_TIME_MS),
    "staleTime must be a finite positive bound so an unsubscribed thread refetches",
  );
});

test("backfillThreadAux merges structural aux and reactions into the content cache", async () => {
  const content = reply();
  const client = makeQueryClientStub([content]);
  const editEvent = { ...reply("3".repeat(64)), kind: 40003 };
  const reactionEvent = { ...reply("4".repeat(64)), kind: 7 };

  await backfillThreadAux(client, CHANNEL_ID, ROOT_ID, [content], {
    fetchStructuralAux: async () => [editEvent],
    fetchReactions: async () => [reactionEvent],
  });

  const cached = client.getQueryData(threadRepliesKey(CHANNEL_ID, ROOT_ID));
  assert.deepEqual(
    cached.map((event) => event.id).sort(),
    [content.id, editEvent.id, reactionEvent.id].sort(),
  );
});

test("backfillThreadAux degrades to bare replies when both aux fetches fail", async () => {
  const content = reply();
  const client = makeQueryClientStub([content]);

  await backfillThreadAux(client, CHANNEL_ID, ROOT_ID, [content], {
    fetchStructuralAux: async () => {
      throw new Error("structural aux down");
    },
    fetchReactions: async () => {
      throw new Error("reactions down");
    },
  });

  const cached = client.getQueryData(threadRepliesKey(CHANNEL_ID, ROOT_ID));
  assert.deepEqual(cached, [content]);
});

test("backfillThreadAux merges over the current cache, not the fetch-time replies", async () => {
  // A live WS append writes a new reply into the cache while aux is in flight;
  // the functional-updater merge must fold aux over that newer cache and keep
  // the appended reply rather than overwriting it with the stale snapshot.
  const original = reply();
  const client = makeQueryClientStub([original]);
  const liveReply = reply("5".repeat(64));
  const reactionEvent = { ...reply("4".repeat(64)), kind: 7 };

  await backfillThreadAux(client, CHANNEL_ID, ROOT_ID, [original], {
    fetchStructuralAux: async () => [],
    fetchReactions: async () => {
      // Simulate the live subscription appending a reply mid-flight.
      client.setQueryData(threadRepliesKey(CHANNEL_ID, ROOT_ID), (current) => [
        ...current,
        liveReply,
      ]);
      return [reactionEvent];
    },
  });

  const cached = client.getQueryData(threadRepliesKey(CHANNEL_ID, ROOT_ID));
  assert.deepEqual(
    cached.map((event) => event.id).sort(),
    [original.id, liveReply.id, reactionEvent.id].sort(),
  );
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function singlePage(events) {
  return async () => ({ events, nextCursor: null });
}

test("loadThreadReplies resolves with content while aux is still pending", async () => {
  const content = reply();
  const client = makeQueryClientStub([]);
  const auxGate = deferred();
  let auxStarted = false;

  const result = await loadThreadReplies(client, CHANNEL_ID, ROOT_ID, {
    fetchPage: singlePage([content]),
    auxDeps: {
      fetchStructuralAux: async () => {
        auxStarted = true;
        await auxGate.promise;
        return [];
      },
      fetchReactions: async () => {
        await auxGate.promise;
        return [];
      },
    },
  });

  // Content is returned before the (still-pending) aux fetch settles: the
  // headline first-paint guarantee. If line resolution regressed to
  // `await backfillThreadAux(...)`, this await would hang until auxGate resolves.
  assert.ok(auxStarted, "aux dispatch should have been fired");
  assert.deepEqual(
    result.map((event) => event.id),
    [content.id],
  );
  auxGate.resolve();
});

test("loadThreadReplies merges aux into the thread cache after content resolves", async () => {
  const content = reply();
  const client = makeQueryClientStub([]);
  const editEvent = { ...reply("3".repeat(64)), kind: 40003 };
  const auxGate = deferred();

  const result = await loadThreadReplies(client, CHANNEL_ID, ROOT_ID, {
    fetchPage: singlePage([content]),
    auxDeps: {
      fetchStructuralAux: async () => {
        await auxGate.promise;
        return [editEvent];
      },
      fetchReactions: async () => {
        await auxGate.promise;
        return [];
      },
    },
  });

  // At resolve time the cache is untouched by aux (content only).
  assert.deepEqual(
    result.map((event) => event.id),
    [content.id],
  );

  // Mirror React Query committing the resolved queryFn value before aux lands.
  client.setQueryData(threadRepliesKey(CHANNEL_ID, ROOT_ID), result);
  auxGate.resolve();
  // Let the fire-and-forget merge microtasks settle.
  await new Promise((resolve) => setTimeout(resolve, 0));

  const cached = client.getQueryData(threadRepliesKey(CHANNEL_ID, ROOT_ID));
  assert.deepEqual(
    cached.map((event) => event.id).sort(),
    [content.id, editEvent.id].sort(),
  );
});

test("loadThreadReplies still resolves content when aux fetches reject", async () => {
  const content = reply();
  const client = makeQueryClientStub([]);

  const result = await loadThreadReplies(client, CHANNEL_ID, ROOT_ID, {
    fetchPage: singlePage([content]),
    auxDeps: {
      fetchStructuralAux: async () => {
        throw new Error("structural aux down");
      },
      fetchReactions: async () => {
        throw new Error("reactions down");
      },
    },
  });

  // Aux rejection is best-effort: the content query succeeds and never sees
  // the error (which would collide with the thread-load error surface).
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(
    result.map((event) => event.id),
    [content.id],
  );
});
