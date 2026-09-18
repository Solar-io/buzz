import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { publishVoiceFinal } from "./voicePublish.ts";
import { waitForRosterInclusion } from "./voiceTranscript.ts";

const AGENT = "a".repeat(64);
const NEW_AGENT = "d".repeat(64);
const MARKED = "[voice] evie are you there";

/** Fakes for one door run; every behavior is asserted off these records. */
function fakeDeps(overrides = {}) {
  const calls = { sent: [], toasts: [], pruned: [] };
  const deps = {
    currentMentions: () => overrides.mentions ?? [AGENT],
    currentFreshAdds: () => overrides.freshAdds ?? [],
    onFreshAddIncluded: (pubkey) => calls.pruned.push(pubkey),
    send: async (message) => {
      calls.sent.push(message);
      return { ok: true, message: "" };
    },
    toastError: (message, options) => calls.toasts.push({ message, options }),
    ...overrides.deps,
  };
  return { calls, deps };
}

test("a [voice] final with a resolved roster is sent with those mentions", async () => {
  const { calls, deps } = fakeDeps();
  await publishVoiceFinal(MARKED, deps);
  assert.equal(calls.sent.length, 1);
  assert.deepEqual(calls.sent[0], {
    content: MARKED,
    mentionPubkeys: [AGENT],
    threadRef: null,
    mediaTags: [],
  });
  assert.equal(calls.toasts.length, 0);
});

test("an empty roster blocks the send and surfaces the visible error", async () => {
  // The defect: mentions empty → dead message, no error anywhere. Both
  // silences are pinned: the send must NOT happen, and the refusal must
  // toast the roster sentence (hardcoded — a wording regression cannot
  // sneak past).
  const { calls, deps } = fakeDeps({ mentions: [] });
  await publishVoiceFinal(MARKED, deps);
  assert.equal(calls.sent.length, 0);
  assert.equal(calls.toasts.length, 1);
  assert.equal(
    calls.toasts[0].message,
    "The agent roster has not resolved yet — nothing was sent. Try again in a moment.",
  );
});

test("an empty roster with a pending fresh add waits, then blocks with the fresh-add error", async () => {
  // The add landed but the snapshot never catches up within the window:
  // the door gives it the bounded wait, then refuses loudly.
  const { calls, deps } = fakeDeps({
    mentions: [],
    freshAdds: [NEW_AGENT],
    deps: {
      waitForRoster: () => waitForRosterInclusion({ isIncluded: () => false }),
    },
  });
  await publishVoiceFinal(MARKED, deps);
  assert.equal(calls.sent.length, 0);
  assert.equal(calls.toasts.length, 1);
  assert.equal(
    calls.toasts[0].message,
    "The roster has not caught up with the new agent yet — nothing was sent. Try again in a moment.",
  );
});

test("a fresh add that lands during the bounded wait publishes with the fresh roster", async () => {
  // Stale pre-add poll: the first gate sees the old roster, the wait sees
  // the merge land, and the final goes out mentioning the NEW agent — the
  // part-3 await-once doing its one job. The fresh add stays in the set
  // until the door prunes it, exactly like HuddleBar's ref.
  let merged = false;
  let pruned = false;
  const { calls, deps } = fakeDeps({
    deps: {
      currentMentions: () => (merged ? [AGENT, NEW_AGENT] : [AGENT]),
      currentFreshAdds: () => (pruned ? [] : [NEW_AGENT]),
      onFreshAddIncluded: (pubkey) => {
        calls.pruned.push(pubkey);
        pruned = true;
      },
      waitForRoster: (options) =>
        waitForRosterInclusion({
          ...options,
          sleep: async () => {
            merged = true;
          },
        }),
    },
  });
  await publishVoiceFinal(MARKED, deps);
  assert.equal(calls.sent.length, 1);
  assert.deepEqual(calls.sent[0].mentionPubkeys, [AGENT, NEW_AGENT]);
  assert.deepEqual(calls.pruned, [NEW_AGENT]);
  assert.equal(calls.toasts.length, 0);
});

test("a fresh add over an already-resolved roster still waits for its own inclusion", async () => {
  // Non-empty mentions plus a missing fresh add: publishing would wake the
  // OLD agents and miss the new one — the false green. Blocked, loudly.
  const { calls, deps } = fakeDeps({
    freshAdds: [NEW_AGENT],
    deps: {
      waitForRoster: () => waitForRosterInclusion({ isIncluded: () => false }),
    },
  });
  await publishVoiceFinal(MARKED, deps);
  assert.equal(calls.sent.length, 0);
  assert.equal(
    calls.toasts[0].message,
    "The roster has not caught up with the new agent yet — nothing was sent. Try again in a moment.",
  );
});

test("a send the relay refuses still surfaces, unchanged", async () => {
  // The pre-V4 contract the door must not disturb: a failed publish toasts
  // the relay's verdict verbatim (AGENTS.md: publish resolves {ok:false},
  // it does not throw).
  const { calls, deps } = fakeDeps({
    deps: {
      send: async () => ({ ok: false, message: "quota exceeded; retry in 4s" }),
    },
  });
  await publishVoiceFinal(MARKED, deps);
  assert.equal(calls.toasts.length, 1);
  assert.equal(calls.toasts[0].message, "quota exceeded; retry in 4s");
});

test("a send that rejects (closed session) toasts instead of throwing", async () => {
  // session.publish REJECTS when the session is closed (relay-session.ts),
  // and the caller fires the door void — an unhandled rejection there is a
  // silent drop, the exact class this door exists to close (QA note N1).
  const { calls, deps } = fakeDeps({
    deps: {
      send: async () => {
        throw new Error("session closed");
      },
    },
  });
  await publishVoiceFinal(MARKED, deps);
  assert.equal(calls.toasts.length, 1);
  assert.equal(calls.toasts[0].message, "session closed");
});

test("the empty-mention gate lives only on the voice-final path", () => {
  // Plain (typed) chat sends are NOT gated — only [voice] finals are. The
  // composer's send path (useMessageActions) must not reference the gate
  // or the door at all, and the bar must route voice finals through the
  // door. Reading the two send paths keeps the scope honest: wiring the
  // gate into the composer would fail this test, as would unwiring it
  // from the bar.
  const composerPath = new URL(
    "../../channels/lib/useMessageActions.ts",
    import.meta.url,
  );
  const composer = readFileSync(composerPath, "utf8");
  assert.ok(
    !composer.includes("gateVoiceMentions"),
    "the composer must not gate",
  );
  assert.ok(
    !composer.includes("publishVoiceFinal"),
    "the composer must not ride the voice door",
  );
  const barPath = new URL("../ui/HuddleBar.tsx", import.meta.url);
  const bar = readFileSync(barPath, "utf8");
  assert.ok(
    bar.includes("publishVoiceFinal"),
    "voice finals must go through the door",
  );
});
