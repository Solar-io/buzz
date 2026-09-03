import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import {
  loadThreadReadState,
  markThreadSeen,
  saveThreadReadState,
  threadSeenAt,
  threadUnreadCount,
} from "./threadReadState.ts";

function memoryStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
}

beforeEach(() => {
  globalThis.localStorage = memoryStorage();
});

const reply = (createdAt) => ({ createdAt });

test("a thread never opened counts every reply as unread", () => {
  const state = loadThreadReadState();
  assert.equal(threadSeenAt(state, "root-1"), 0);
  assert.equal(threadUnreadCount([reply(10), reply(20)], 0), 2);
});

test("only replies newer than the marker count", () => {
  const replies = [reply(10), reply(20), reply(30)];
  assert.equal(threadUnreadCount(replies, 20), 1);
  assert.equal(threadUnreadCount(replies, 30), 0);
  assert.equal(threadUnreadCount(replies, 5), 3);
});

test("the marker only ever moves forward", () => {
  let state = markThreadSeen({}, "root-1", 100);
  assert.equal(state["root-1"], 100);
  const same = markThreadSeen(state, "root-1", 50);
  assert.equal(
    same,
    state,
    "an older timestamp is a no-op, object identity kept",
  );
  state = markThreadSeen(state, "root-1", 150);
  assert.equal(state["root-1"], 150);
});

test("markThreadSeen does not mutate the state it is given", () => {
  const before = { "root-1": 10 };
  const after = markThreadSeen(before, "root-1", 20);
  assert.equal(before["root-1"], 10);
  assert.equal(after["root-1"], 20);
});

test("threads keep separate markers", () => {
  let state = markThreadSeen({}, "root-1", 100);
  state = markThreadSeen(state, "root-2", 40);
  assert.equal(threadSeenAt(state, "root-1"), 100);
  assert.equal(threadSeenAt(state, "root-2"), 40);
  assert.equal(threadSeenAt(state, "root-3"), 0);
});

test("markers survive a round trip through storage", () => {
  saveThreadReadState(markThreadSeen({}, "root-1", 777));
  assert.equal(threadSeenAt(loadThreadReadState(), "root-1"), 777);
});

test("thread markers live apart from the channel read state", () => {
  saveThreadReadState({ "root-1": 5 });
  assert.equal(
    globalThis.localStorage.getItem("buzz.read-state.v1"),
    null,
    "writing a thread marker must never touch the channel key",
  );
  assert.notEqual(globalThis.localStorage.getItem("buzz.thread-read.v1"), null);
});

test("corrupt storage reads as empty rather than throwing", () => {
  globalThis.localStorage.setItem("buzz.thread-read.v1", "{not json");
  assert.deepEqual(loadThreadReadState(), {});
});
