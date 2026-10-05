import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createVoiceLatencyRecorder,
  VOICE_LATENCY_RING_SIZE,
  voiceLatency,
} from "./voiceLatency.ts";

// Plan VOICE_STREAMED_REPLIES_2026-10-04 §5 row 0: the recorder pairs t0
// with the next reply from the same call and ignores other channels.

const AGENT = "A".repeat(64);
const CALL = "call-1111";
const OTHER_CALL = "call-2222";

function fixture() {
  const c = { t: 0 };
  const lines = [];
  const recorder = createVoiceLatencyRecorder({
    now: () => c.t,
    log: (line) => lines.push(line),
    publish: null,
  });
  return { c, lines, recorder };
}

test("t0 pairs with the next reply in the SAME call, not another call's", () => {
  const { c, recorder } = fixture();
  recorder.voiceTurn(CALL, "voice-1");
  c.t = 400;
  assert.equal(
    recorder.reply(OTHER_CALL, AGENT, "final"),
    null,
    "a reply in another call does not claim this call's turn",
  );
  c.t = 1_500;
  const reply = recorder.reply(CALL, AGENT, "stream");
  assert.ok(reply);
  c.t = 1_700;
  reply.ttsRequested();
  c.t = 2_100;
  reply.audioStarted();
  const [record] = recorder.records();
  assert.deepEqual(record, {
    channelId: "call-1111",
    triggerId: "voice-1",
    agentPubkey: "a".repeat(64),
    t0: 0,
    tSeg0: 1_500,
    tTts0: 1_700,
    tAudio0: 2_100,
    path: "stream",
  });
});

test("a turn is claimed once: the second reply has nothing to pair with", () => {
  const { recorder } = fixture();
  recorder.voiceTurn(CALL, "voice-1");
  assert.ok(recorder.reply(CALL, AGENT, "final"));
  assert.equal(recorder.reply(CALL, AGENT, "final"), null);
});

test("no [voice] turn open: an unprompted reply is not a sample", () => {
  const { recorder } = fixture();
  assert.equal(recorder.reply(CALL, AGENT, "final"), null);
  assert.equal(recorder.records().length, 0);
});

test("the e tag picks its own turn; otherwise the latest turn wins and older ones close", () => {
  const { c, recorder } = fixture();
  recorder.voiceTurn(CALL, "voice-1");
  c.t = 100;
  recorder.voiceTurn(CALL, "voice-2");
  c.t = 200;
  recorder.voiceTurn(CALL, "voice-3");
  c.t = 900;
  const tagged = recorder.reply(CALL, AGENT, "stream", "voice-2");
  assert.ok(tagged);
  const byId = Object.fromEntries(
    recorder.records().map((r) => [r.triggerId, r]),
  );
  assert.equal(byId["voice-2"].path, "stream");
  assert.equal(byId["voice-1"].path, null);
  // voice-1 is older than the claimed turn, so it closed; voice-3 is open.
  const next = recorder.reply(CALL, AGENT, "final");
  assert.ok(next);
  assert.equal(byId["voice-3"].path, "final");
  assert.equal(recorder.reply(CALL, AGENT, "final"), null, "voice-1 closed");
});

test("final path has no tSeg0; milestones are recorded once", () => {
  const { c, recorder } = fixture();
  recorder.voiceTurn(CALL, "voice-1");
  c.t = 50;
  const reply = recorder.reply(CALL, AGENT, "final");
  c.t = 60;
  reply.ttsRequested();
  c.t = 90;
  reply.ttsRequested();
  reply.audioStarted();
  c.t = 500;
  reply.audioStarted();
  const [r] = recorder.records();
  assert.equal(r.tSeg0, null);
  assert.equal(r.tTts0, 60);
  assert.equal(r.tAudio0, 90);
});

test("console lines carry the deltas from t0", () => {
  const { c, lines, recorder } = fixture();
  recorder.voiceTurn("0123456789abcdef", "fedcba9876543210");
  c.t = 1_234;
  const reply = recorder.reply("0123456789abcdef", AGENT, "stream");
  c.t = 1_300;
  reply.ttsRequested();
  c.t = 1_550.4;
  reply.audioStarted();
  assert.deepEqual(lines, [
    "[voice-latency] t0 channel=01234567 trigger=fedcba98 path=- seg0=- tts0=- audio0=-",
    "[voice-latency] reply channel=01234567 trigger=fedcba98 path=stream seg0=+1234ms tts0=- audio0=-",
    "[voice-latency] tts0 channel=01234567 trigger=fedcba98 path=stream seg0=+1234ms tts0=+1300ms audio0=-",
    "[voice-latency] audio0 channel=01234567 trigger=fedcba98 path=stream seg0=+1234ms tts0=+1300ms audio0=+1550ms",
  ]);
});

test("the ring keeps the last 50 records", () => {
  const { recorder } = fixture();
  assert.equal(VOICE_LATENCY_RING_SIZE, 50);
  for (let i = 0; i < 53; i++) recorder.voiceTurn(CALL, `voice-${i}`);
  const ring = recorder.records();
  assert.equal(ring.length, 50);
  assert.equal(ring[0].triggerId, "voice-3");
  assert.equal(ring[49].triggerId, "voice-52");
});

test("the same [voice] event is recorded once", () => {
  const { recorder } = fixture();
  recorder.voiceTurn(CALL, "voice-1");
  recorder.voiceTurn(CALL, "voice-1");
  assert.equal(recorder.records().length, 1);
});

test("the shared recorder publishes its ring on window.__buzzVoiceLatency", () => {
  const saved = globalThis.window;
  const savedInfo = console.info;
  globalThis.window = {};
  console.info = () => {};
  try {
    const shared = voiceLatency();
    shared.voiceTurn("call-x", "voice-window");
    assert.equal(globalThis.window.__buzzVoiceLatency, shared.records());
    assert.equal(
      globalThis.window.__buzzVoiceLatency.at(-1).triggerId,
      "voice-window",
    );
  } finally {
    console.info = savedInfo;
    globalThis.window = saved;
  }
});
