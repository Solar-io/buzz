import assert from "node:assert/strict";
import { test } from "node:test";

const {
  BARGE_MIC_HOT_MS,
  initialDuplexState,
  micHeld,
  micHoldNotice,
  nextMicHold,
} = await import("./duplexGate.ts");

/** Fold a list of events through the reducer, collecting the interrupts. */
function run(state, events) {
  const interrupts = [];
  let current = state;
  for (const event of events) {
    const step = nextMicHold(current, event);
    current = step.state;
    if (step.interrupt) {
      interrupts.push(event);
    }
  }
  return { state: current, interrupts };
}

test("half-duplex holds the mic when the agent starts and releases when she stops", () => {
  const start = nextMicHold(initialDuplexState("half"), {
    type: "agent_speech_start",
  });
  assert.equal(start.state.held, true, "the mic is held while she speaks");
  assert.equal(micHeld(start.state), true);
  assert.equal(start.interrupt, false, "half-duplex never interrupts");
  const end = nextMicHold(start.state, { type: "agent_speech_end" });
  assert.equal(end.state.held, false, "the hold releases when she stops");
  assert.equal(micHeld(end.state), false);
});

test("barge-in never holds the mic", () => {
  const { state } = run(initialDuplexState("barge"), [
    { type: "agent_speech_start" },
    { type: "mic_level", speaking: true, at: 1_000 },
  ]);
  // The discriminating value: under "half" the same sequence yields held=true.
  assert.equal(state.held, false);
  assert.equal(micHeld(state), false);
});

test("barge-in interrupts only after the mic has been hot for the debounce", () => {
  const hot = nextMicHold(
    run(initialDuplexState("barge"), [{ type: "agent_speech_start" }]).state,
    { type: "mic_level", speaking: true, at: 10_000 },
  ).state;

  // Too soon: 299 ms of hot mic is speaker echo's territory.
  const early = nextMicHold(hot, {
    type: "interim",
    text: "hang on",
    at: 10_000 + BARGE_MIC_HOT_MS - 1,
  });
  assert.equal(early.interrupt, false, "299 ms must not interrupt");

  // Exactly at the threshold, and past it: a person leaning in.
  assert.equal(
    nextMicHold(hot, {
      type: "interim",
      text: "hang on",
      at: 10_000 + BARGE_MIC_HOT_MS,
    }).interrupt,
    true,
    "300 ms interrupts",
  );
  assert.equal(
    nextMicHold(hot, { type: "interim", text: "hang on", at: 12_000 })
      .interrupt,
    true,
  );
});

test("a mic that goes quiet restarts the barge debounce", () => {
  const { state } = run(initialDuplexState("barge"), [
    { type: "agent_speech_start" },
    { type: "mic_level", speaking: true, at: 0 },
    { type: "mic_level", speaking: false, at: 500 },
    { type: "mic_level", speaking: true, at: 900 },
  ]);
  assert.equal(state.micHotSince, 900, "the streak restarts at the new edge");
  assert.equal(
    nextMicHold(state, { type: "interim", text: "wait", at: 1_100 }).interrupt,
    false,
    "200 ms into the NEW streak is still too soon",
  );
  assert.equal(
    nextMicHold(state, { type: "interim", text: "wait", at: 1_250 }).interrupt,
    true,
  );
});

test("a continuing hot mic keeps its original start, so the streak accumulates", () => {
  const { state } = run(initialDuplexState("barge"), [
    { type: "agent_speech_start" },
    { type: "mic_level", speaking: true, at: 100 },
    { type: "mic_level", speaking: true, at: 200 },
    { type: "mic_level", speaking: true, at: 350 },
  ]);
  assert.equal(state.micHotSince, 100);
  assert.equal(
    nextMicHold(state, { type: "interim", text: "stop", at: 400 }).interrupt,
    true,
  );
});

test("an interim with no real speech never interrupts", () => {
  const { state } = run(initialDuplexState("barge"), [
    { type: "agent_speech_start" },
    { type: "mic_level", speaking: true, at: 0 },
  ]);
  for (const text of ["", "   ", "\n\t "]) {
    assert.equal(
      nextMicHold(state, { type: "interim", text, at: 5_000 }).interrupt,
      false,
      `empty interim ${JSON.stringify(text)} must not interrupt`,
    );
  }
});

test("nothing interrupts while the agent is silent", () => {
  const { state } = run(initialDuplexState("barge"), [
    { type: "mic_level", speaking: true, at: 0 },
  ]);
  assert.equal(state.agentSpeaking, false);
  assert.equal(
    nextMicHold(state, { type: "interim", text: "hello", at: 9_000 }).interrupt,
    false,
  );
});

test("user mute outranks everything: no interrupt, and the hold never unmutes", () => {
  // Barge-in, mic hot for ages, agent talking — but the user is muted.
  const { state } = run(initialDuplexState("barge"), [
    { type: "agent_speech_start" },
    { type: "mic_level", speaking: true, at: 0 },
    { type: "user_mute", muted: true },
  ]);
  assert.equal(state.userMuted, true);
  assert.equal(state.micHotSince, null, "mute clears the hot-mic streak");
  assert.equal(
    nextMicHold(state, { type: "interim", text: "excuse me", at: 60_000 })
      .interrupt,
    false,
    "a muted mic cannot barge in",
  );
  // ...and a level report while muted cannot re-arm it.
  assert.equal(
    nextMicHold(state, { type: "mic_level", speaking: true, at: 61_000 }).state
      .micHotSince,
    null,
  );

  // Half-duplex: the gate's hold is a SEPARATE flag from the user's mute,
  // so releasing the hold leaves the mute exactly where the user put it.
  const half = run(initialDuplexState("half"), [
    { type: "user_mute", muted: true },
    { type: "agent_speech_start" },
    { type: "agent_speech_end" },
  ]);
  assert.equal(half.state.held, false, "the gate released its own hold");
  assert.equal(half.state.userMuted, true, "the user is still muted");
});

test("switching mode mid-speech applies or releases the hold immediately", () => {
  const speaking = nextMicHold(initialDuplexState("half"), {
    type: "agent_speech_start",
  }).state;
  assert.equal(speaking.held, true);
  const toBarge = nextMicHold(speaking, { type: "set_mode", mode: "barge" });
  assert.equal(toBarge.state.held, false, "barge-in releases a live hold");
  const back = nextMicHold(toBarge.state, { type: "set_mode", mode: "half" });
  assert.equal(back.state.held, true, "half-duplex re-holds while she speaks");
  assert.equal(back.state.agentSpeaking, true);
});

test("reset returns to rest while keeping the channel's chosen mode", () => {
  const { state } = run(initialDuplexState("barge"), [
    { type: "agent_speech_start" },
    { type: "mic_level", speaking: true, at: 10 },
    { type: "user_mute", muted: true },
    { type: "reset" },
  ]);
  assert.deepEqual(state, initialDuplexState("barge"));
  assert.equal(state.mode, "barge", "the mode is a preference, not call state");
});

test("the hold notice names the agent, and says nothing when the mic is free", () => {
  const held = nextMicHold(initialDuplexState("half"), {
    type: "agent_speech_start",
  }).state;
  assert.equal(micHoldNotice(held, "Evie"), "Mic paused while Evie speaks");
  assert.equal(micHoldNotice(initialDuplexState("half"), "Evie"), null);
  assert.equal(
    micHoldNotice(
      nextMicHold(initialDuplexState("barge"), { type: "agent_speech_start" })
        .state,
      "Evie",
    ),
    null,
    "barge-in never shows a hold notice",
  );
});
