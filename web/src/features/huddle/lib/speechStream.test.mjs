import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGENT_SPEECH_SEGMENT_KIND,
  createSpeechQueue,
  createSpeechStreamTracker,
  isAgentSpeechSegment,
  parseSpeechSegment,
  SPEECH_STREAM_TAG,
  STREAMED_REPLIES_STORAGE_KEY,
  streamedRepliesEnabled,
  wordOverlap,
} from "./speechStream.ts";

// Plan VOICE_STREAMED_REPLIES_2026-10-04 §5 row 4. Every expected string is
// written out by hand — never derived from the code's own constants.

const AGENT = "a".repeat(64);
const OTHER = "b".repeat(64);
const HUMAN = "c".repeat(64);
const CHANNEL = "call-1";
const SID = "turn-42";

const FINAL_TEXT =
  "Sure. It's 72 degrees in Austin right now. Want the forecast?";
// Offsets into FINAL_TEXT (UTF-16): "Sure." 0-5, " It's…now." 5-42, " Want…?" 42-61.

function seg(seq, offset, content, extra = {}) {
  const tags = [
    ["h", extra.channel ?? CHANNEL],
    ["buzz-speech", extra.sid ?? SID, String(seq), String(offset)],
  ];
  if (extra.trigger) tags.push(["e", extra.trigger, "", "reply"]);
  if (extra.done !== undefined) tags.push(["done", String(extra.done)]);
  return {
    kind: 24820,
    pubkey: extra.pubkey ?? AGENT,
    content,
    tags,
  };
}

function final(content, extra = {}) {
  return {
    kind: 9,
    pubkey: extra.pubkey ?? AGENT,
    content,
    tags: [
      ["h", CHANNEL],
      ["buzz-speech", extra.sid ?? SID, "3", String(content.length)],
    ],
  };
}

function clock(start = 1_000) {
  const c = { t: start, now: () => c.t };
  return c;
}

function tracker(c = clock()) {
  return createSpeechStreamTracker({ now: c.now, log: () => {} });
}

test("the wire constants are hardcoded", () => {
  assert.equal(AGENT_SPEECH_SEGMENT_KIND, 24820);
  assert.equal(SPEECH_STREAM_TAG, "buzz-speech");
  assert.equal(STREAMED_REPLIES_STORAGE_KEY, "buzz.voice.streamedReplies");
});

test("parse: a well-formed segment decodes seq, offset, done and e", () => {
  const parsed = parseSpeechSegment(
    seg(2, 42, "", { done: 61, trigger: "f".repeat(64) }),
  );
  assert.deepEqual(parsed, {
    streamId: "turn-42",
    seq: 2,
    offset: 42,
    done: 61,
    triggerId: "f".repeat(64),
  });
  assert.equal(parseSpeechSegment({ ...seg(0, 0, "x"), kind: 9 }), null);
  const bad = seg(0, 0, "x");
  bad.tags[1] = ["buzz-speech", SID, "-1", "0"];
  assert.equal(parseSpeechSegment(bad), null, "negative seq is malformed");
});

test("in order: each segment is spoken once, the done marker ends the stream", () => {
  const t = tracker();
  const a = t.onSegment(seg(0, 0, "Sure."));
  assert.equal(a.isNew, true);
  assert.deepEqual(a.speak, ["Sure."]);
  assert.equal(a.ended, false);
  const b = t.onSegment(seg(1, 5, " It's 72 degrees in Austin right now."));
  assert.equal(b.isNew, false);
  assert.deepEqual(b.speak, ["It's 72 degrees in Austin right now."]);
  const c = t.onSegment(seg(2, 42, " Want the forecast?", { done: 61 }));
  assert.deepEqual(c.speak, ["Want the forecast?"]);
  assert.equal(c.ended, true);
  assert.equal(t.hasOpenStreams(), false);
});

test("a duplicate segment is ignored — it is not held as a phantom gap either", () => {
  const c = clock();
  const t = tracker(c);
  t.onSegment(seg(0, 0, "Sure."));
  const again = t.onSegment(seg(0, 0, "Sure."));
  assert.deepEqual(again.speak, []);
  c.t += 3_500;
  assert.deepEqual(t.poll(), [], "a re-delivered seq 0 is never spoken again");
  t.onSegment(seg(2, 42, " Want the forecast?"));
  const heldAgain = t.onSegment(seg(2, 42, " Want the forecast?"));
  assert.deepEqual(heldAgain.speak, [], "a held duplicate is not re-queued");
  const fill = t.onSegment(seg(1, 5, " It's 72 degrees in Austin right now."));
  assert.deepEqual(fill.speak, [
    "It's 72 degrees in Austin right now.",
    "Want the forecast?",
  ]);
});

test("out of order: a later segment waits behind the gap, which the final's tail fills", () => {
  const t = tracker();
  assert.deepEqual(t.onSegment(seg(0, 0, "Sure.")).speak, ["Sure."]);
  const held = t.onSegment(seg(2, 42, " Want the forecast?", { done: 61 }));
  assert.deepEqual(held.speak, [], "seq 2 is held until seq 1 arrives");
  assert.equal(held.ended, false);
  const decision = t.onFinal(final(FINAL_TEXT));
  assert.equal(decision.streamOpen, true);
  assert.equal(
    decision.text,
    "It's 72 degrees in Austin right now. Want the forecast?",
  );
  assert.equal(t.hasOpenStreams(), false);
});

test("whitespace the harness puts BETWEEN segments (a tool boundary) is not a gap", () => {
  const t = tracker();
  t.onSegment(seg(0, 0, "Let me check."));
  // Offset jumps by 2 ("\n\n" in the final text) but seq is contiguous.
  const after = t.onSegment(seg(1, 15, "It is sunny.", { done: 27 }));
  assert.deepEqual(after.speak, ["It is sunny."]);
  assert.equal(after.ended, true);
});

test("a final after the whole stream was spoken says nothing", () => {
  const t = tracker();
  t.onSegment(seg(0, 0, "Sure."));
  t.onSegment(seg(1, 5, " It's 72 degrees in Austin right now."));
  t.onSegment(seg(2, 42, " Want the forecast?", { done: 61 }));
  const decision = t.onFinal(final(FINAL_TEXT));
  assert.equal(decision.text, null);
  assert.equal(decision.streamOpen, false);
});

test("a final whose stream was partly spoken says only the rest", () => {
  const t = tracker();
  t.onSegment(seg(0, 0, "Sure."));
  const decision = t.onFinal(final(FINAL_TEXT));
  assert.equal(
    decision.text,
    "It's 72 degrees in Austin right now. Want the forecast?",
  );
  assert.equal(decision.streamOpen, true);
});

test("a final for a stream never seen is spoken whole, and late segments are refused", () => {
  const t = tracker();
  const decision = t.onFinal(final(FINAL_TEXT));
  assert.equal(
    decision.text,
    "Sure. It's 72 degrees in Austin right now. Want the forecast?",
  );
  assert.equal(decision.streamOpen, false);
  assert.equal(t.onSegment(seg(0, 0, "Sure.")), null);
});

test("an untagged kind:9 is not a final", () => {
  const t = tracker();
  assert.equal(
    t.onFinal({ kind: 9, pubkey: AGENT, content: "hi", tags: [] }),
    null,
  );
});

test("cut: later segments and the final's tail are dropped; other agents keep talking", () => {
  const t = tracker();
  t.onSegment(seg(0, 0, "Sure."));
  t.onSegment(
    seg(0, 0, "Hello from the other one.", { pubkey: OTHER, sid: "x" }),
  );
  const cutKeys = t.cut(AGENT);
  assert.deepEqual(cutKeys, [`${AGENT}:turn-42`]);
  assert.equal(
    t.onSegment(seg(1, 5, " It's 72 degrees in Austin right now.")),
    null,
  );
  const decision = t.onFinal(final(FINAL_TEXT));
  assert.equal(decision.text, null, "the tail of a cut stream is never spoken");
  const other = t.onSegment(
    seg(1, 25, " Still here.", { pubkey: OTHER, sid: "x" }),
  );
  assert.deepEqual(other.speak, ["Still here."]);
});

test("cut() with no pubkey cuts every open stream", () => {
  const t = tracker();
  t.onSegment(seg(0, 0, "One."));
  t.onSegment(seg(0, 0, "Two.", { pubkey: OTHER, sid: "y" }));
  assert.equal(t.cut().length, 2);
  assert.equal(t.hasOpenStreams(), false);
});

test("untagged CLI duplicate of the stream is suppressed; an unrelated message is not", () => {
  const c = clock();
  const t = tracker(c);
  t.onSegment(seg(0, 0, "Sure."));
  t.onSegment(seg(1, 5, " It's 72 degrees in Austin right now.", { done: 42 }));
  c.t += 5_000;
  const cliCopy = {
    kind: 9,
    pubkey: AGENT,
    content: "Sure, it's 72 degrees in Austin right now!",
    tags: [["h", CHANNEL]],
  };
  assert.equal(t.onUntagged(cliCopy), true);
  const unrelated = {
    kind: 9,
    pubkey: AGENT,
    content: "Also, your build on main just finished green.",
    tags: [["h", CHANNEL]],
  };
  assert.equal(t.onUntagged(unrelated), false);
  const fromOther = { ...cliCopy, pubkey: OTHER };
  assert.equal(
    t.onUntagged(fromOther),
    false,
    "another agent's stream is not it",
  );
});

test("the duplicate window is 20 s after the agent's last stream activity", () => {
  const c = clock();
  const t = tracker(c);
  t.onSegment(seg(0, 0, "It's 72 degrees in Austin.", { done: 26 }));
  const copy = {
    kind: 9,
    pubkey: AGENT,
    content: "It's 72 degrees in Austin.",
    tags: [["h", CHANNEL]],
  };
  c.t += 19_000;
  assert.equal(t.onUntagged(copy), true);
  c.t += 2_000; // 21 s
  assert.equal(t.onUntagged(copy), false);
});

test("word overlap is the candidate's distinct words found in the reference", () => {
  assert.equal(wordOverlap("Hello there", "hello, THERE friend"), 1);
  assert.equal(wordOverlap("one two three four", "one two"), 0.5);
  assert.equal(wordOverlap("", "anything"), 0);
});

test("gap policy: a missing segment is held 3 s, then skipped", () => {
  const c = clock();
  const t = tracker(c);
  t.onSegment(seg(0, 0, "Sure."));
  t.onSegment(seg(2, 42, " Want the forecast?"));
  c.t += 2_900;
  assert.deepEqual(t.poll(), [], "still holding at 2.9 s");
  c.t += 200;
  const [skip] = t.poll();
  assert.deepEqual(skip.speak, ["Want the forecast?"]);
  assert.equal(skip.ended, false);
  // The skipped segment arriving late is a duplicate now.
  assert.deepEqual(
    t.onSegment(seg(1, 5, " It's 72 degrees in Austin right now.")).speak,
    [],
  );
});

test("an open stream with no done marker closes after 90 s idle", () => {
  const c = clock();
  const t = tracker(c);
  t.onSegment(seg(0, 0, "Let me check."));
  c.t += 89_000;
  assert.deepEqual(t.poll(), []);
  assert.equal(t.hasOpenStreams(), true);
  c.t += 1_000;
  const [closed] = t.poll();
  assert.equal(closed.key, `${AGENT}:turn-42`);
  assert.equal(closed.ended, true);
  assert.equal(t.hasOpenStreams(), false);
});

test("[System] segments advance the stream but are not spoken", () => {
  const t = tracker();
  const s = t.onSegment(seg(0, 0, "[System] tool output"));
  assert.deepEqual(s.speak, []);
  assert.deepEqual(t.onSegment(seg(1, 20, " Done.")).speak, ["Done."]);
});

test("segment gates: channel, membership, self", () => {
  const agents = new Set([AGENT]);
  assert.equal(
    isAgentSpeechSegment(seg(0, 0, ""), agents, HUMAN, CHANNEL),
    true,
  );
  assert.equal(
    isAgentSpeechSegment(
      seg(0, 0, "", { channel: "elsewhere" }),
      agents,
      HUMAN,
      CHANNEL,
    ),
    false,
  );
  assert.equal(
    isAgentSpeechSegment(
      seg(0, 0, "", { pubkey: OTHER }),
      agents,
      HUMAN,
      CHANNEL,
    ),
    false,
  );
  assert.equal(
    isAgentSpeechSegment(seg(0, 0, ""), agents, AGENT, CHANNEL),
    false,
  );
  assert.equal(
    isAgentSpeechSegment({ ...seg(0, 0, ""), kind: 9 }, agents, HUMAN, CHANNEL),
    false,
  );
});

test("client switch: default on; false/off/0 turn it off", () => {
  const store = (value) => ({
    getItem: (k) => (k === "buzz.voice.streamedReplies" ? value : null),
  });
  assert.equal(streamedRepliesEnabled(store(null)), true);
  assert.equal(streamedRepliesEnabled(null), true);
  assert.equal(streamedRepliesEnabled(store("true")), true);
  assert.equal(streamedRepliesEnabled(store("false")), false);
  assert.equal(streamedRepliesEnabled(store("off")), false);
  assert.equal(streamedRepliesEnabled(store(" 0 ")), false);
  const throwing = {
    getItem() {
      throw new Error("SecurityError");
    },
  };
  assert.equal(streamedRepliesEnabled(throwing), true);
});

test("speech queue: waits for a push, drains, then resolves null once closed", async () => {
  const q = createSpeechQueue();
  assert.equal(q.ready(), false);
  const waiting = q.next();
  q.push("one");
  assert.equal(await waiting, "one");
  q.push("two");
  assert.equal(q.ready(), true);
  q.close();
  assert.equal(await q.next(), "two");
  assert.equal(await q.next(), null);
  q.push("late");
  assert.equal(await q.next(), null, "nothing is accepted after close");
});
