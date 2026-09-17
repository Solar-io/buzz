import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGENT_VOICE_D_TAG,
  KIND_AGENT_VOICE,
  parseAgentVoiceEvent,
  reduceAgentVoiceEvents,
} from "./agentVoiceSelection.ts";

const AUTHOR = "a".repeat(64);
const OTHER = "b".repeat(64);

const LOCAL_SYNTH_BODY = {
  version: 1,
  engine: "local-synth",
  voiceURI: "com.apple.speech.synthesis.voice.Samantha",
  label: "Samantha",
};

const POCKET_BODY = {
  version: 1,
  engine: "pocket",
  key: "pocket:azelma",
  label: "Azelma",
};

function selectionEvent(overrides = {}) {
  return {
    pubkey: AUTHOR,
    content: JSON.stringify(LOCAL_SYNTH_BODY),
    created_at: 1_700_000_000,
    tags: [["d", "agent-voice"]],
    ...overrides,
  };
}

// ── Kind constants ─────────────────────────────────────────────────────────

test("the kind constant pins 30182 and the fixed d tag", () => {
  assert.equal(KIND_AGENT_VOICE, 30182);
  assert.equal(AGENT_VOICE_D_TAG, "agent-voice");
});

// ── Parse: accepted shapes ─────────────────────────────────────────────────

test("a local-synth selection parses with its provenance", () => {
  const row = parseAgentVoiceEvent(selectionEvent());
  assert.equal(row.pubkey, AUTHOR);
  assert.equal(row.createdAt, 1_700_000_000);
  assert.deepEqual(row.selection, {
    engine: "local-synth",
    voiceURI: "com.apple.speech.synthesis.voice.Samantha",
  });
  assert.equal(row.label, "Samantha");
});

test("a pocket selection with a bundled catalog key parses", () => {
  const row = parseAgentVoiceEvent(
    selectionEvent({ content: JSON.stringify(POCKET_BODY) }),
  );
  assert.deepEqual(row.selection, { engine: "pocket", key: "pocket:azelma" });
});

test("a pocket selection with a full imported catalog key parses", () => {
  const hash = "6".repeat(64);
  const row = parseAgentVoiceEvent(
    selectionEvent({
      content: JSON.stringify({
        ...POCKET_BODY,
        key: `pocket:imported:${hash}`,
      }),
    }),
  );
  assert.deepEqual(row.selection, {
    engine: "pocket",
    key: `pocket:imported:${hash}`,
  });
});

// ── Parse: refused shapes (the relay would refuse them too) ────────────────

test("parse rejects a d tag that is not the fixed constant", () => {
  // 30181-style key addressing must not fork the author's selection.
  assert.equal(
    parseAgentVoiceEvent(selectionEvent({ tags: [["d", "pocket:azelma"]] })),
    null,
  );
  assert.equal(parseAgentVoiceEvent(selectionEvent({ tags: [] })), null);
  assert.equal(
    parseAgentVoiceEvent(
      selectionEvent({
        tags: [
          ["d", "agent-voice"],
          ["d", "agent-voice"],
        ],
      }),
    ),
    null,
  );
});

test("parse rejects a version other than 1", () => {
  const body = { ...LOCAL_SYNTH_BODY, version: 2 };
  assert.equal(
    parseAgentVoiceEvent(selectionEvent({ content: JSON.stringify(body) })),
    null,
  );
  assert.equal(
    parseAgentVoiceEvent(
      selectionEvent({ content: JSON.stringify({ ...body, version: "1" }) }),
    ),
    null,
  );
});

test("parse rejects an unknown engine", () => {
  const body = { ...LOCAL_SYNTH_BODY, engine: "siri", voiceURI: undefined };
  assert.equal(
    parseAgentVoiceEvent(selectionEvent({ content: JSON.stringify(body) })),
    null,
  );
});

test("parse rejects local-synth without a usable voiceURI", () => {
  const noUri = { ...LOCAL_SYNTH_BODY };
  delete noUri.voiceURI;
  assert.equal(
    parseAgentVoiceEvent(selectionEvent({ content: JSON.stringify(noUri) })),
    null,
  );
  const emptyUri = { ...LOCAL_SYNTH_BODY, voiceURI: "" };
  assert.equal(
    parseAgentVoiceEvent(selectionEvent({ content: JSON.stringify(emptyUri) })),
    null,
  );
});

test("parse rejects a pocket key outside the catalog grammar", () => {
  for (const key of [
    "siri:aaron",
    "pocket:",
    "pocket:Imported",
    "pocket:imported:short",
  ]) {
    const body = { ...POCKET_BODY, key };
    assert.equal(
      parseAgentVoiceEvent(selectionEvent({ content: JSON.stringify(body) })),
      null,
      `key ${key} must be refused`,
    );
  }
});

test("parse drops a pocket:eve selection — the identity-test ban is selectable nowhere", () => {
  const body = { ...POCKET_BODY, key: "pocket:eve" };
  assert.equal(
    parseAgentVoiceEvent(selectionEvent({ content: JSON.stringify(body) })),
    null,
  );
});

test("parse rejects a missing, empty, over-long, or control-bearing label", () => {
  const missing = { ...LOCAL_SYNTH_BODY };
  delete missing.label;
  assert.equal(
    parseAgentVoiceEvent(selectionEvent({ content: JSON.stringify(missing) })),
    null,
  );
  assert.equal(
    parseAgentVoiceEvent(
      selectionEvent({
        content: JSON.stringify({ ...LOCAL_SYNTH_BODY, label: "" }),
      }),
    ),
    null,
  );
  assert.equal(
    parseAgentVoiceEvent(
      selectionEvent({
        content: JSON.stringify({
          ...LOCAL_SYNTH_BODY,
          label: "l".repeat(129),
        }),
      }),
    ),
    null,
  );
  assert.equal(
    parseAgentVoiceEvent(
      selectionEvent({
        content: JSON.stringify({ ...LOCAL_SYNTH_BODY, label: "a\nb" }),
      }),
    ),
    null,
  );
});

test("parse survives unparseable content", () => {
  assert.equal(
    parseAgentVoiceEvent(selectionEvent({ content: "not json" })),
    null,
  );
});

// ── Fold ───────────────────────────────────────────────────────────────────

test("reduce folds LWW per agent pubkey in either arrival order", () => {
  const older = selectionEvent({
    content: JSON.stringify({ ...LOCAL_SYNTH_BODY, label: "Older" }),
    created_at: 100,
  });
  const newer = selectionEvent({
    content: JSON.stringify({ ...POCKET_BODY, label: "Newer" }),
    created_at: 200,
  });
  const folded = reduceAgentVoiceEvents([older, newer]);
  assert.equal(folded.size, 1);
  assert.equal(folded.get(AUTHOR).label, "Newer");
  assert.equal(folded.get(AUTHOR).selection.engine, "pocket");
  assert.equal(
    reduceAgentVoiceEvents([newer, older]).get(AUTHOR).label,
    "Newer",
  );
});

test("reduce keeps distinct agents apart", () => {
  const mine = selectionEvent();
  const theirs = selectionEvent({ pubkey: OTHER, created_at: 200 });
  const folded = reduceAgentVoiceEvents([mine, theirs]);
  assert.equal(folded.size, 2);
  assert.ok(folded.has(AUTHOR));
  assert.ok(folded.has(OTHER));
});

test("reduce keys are lowercase pubkeys — the speech path classifies with toLowerCase", () => {
  const mixed = selectionEvent({ pubkey: `A${"b".repeat(63)}` });
  const folded = reduceAgentVoiceEvents([mixed]);
  assert.equal(folded.size, 1);
  assert.ok(folded.has(`a${"b".repeat(63)}`));
});

test("reduce drops refused events rather than failing", () => {
  const eve = selectionEvent({
    content: JSON.stringify({ ...POCKET_BODY, key: "pocket:eve" }),
    pubkey: OTHER,
  });
  const folded = reduceAgentVoiceEvents([eve, selectionEvent()]);
  assert.equal(folded.size, 1);
  assert.ok(!folded.has(OTHER));
});

// ── Wiring (carrying, skipped) ─────────────────────────────────────────────

test("wiring: useHuddleAgentSpeech consumes agentVoiceSelectionFor(pubkey) as the selected? input — " +
  "BLOCKED on the speak-time seam (CK's window owns huddleAgentSpeech.ts / useHuddleAgentSpeech.ts). " +
  "When it lands: speechVoiceProfile(pubkey, rankedVoices, selected?) builds a profile whose source is " +
  "'selected' | 'selected-rejected' | 'derived', and the assertion must check WHICH path spoke.", {
  skip: "carrying test — the seam call site is another seat's one-liner, not yet landed",
}, () => {
  assert.fail(
    "unskip when useHuddleAgentSpeech passes agentVoiceSelectionFor through",
  );
});
