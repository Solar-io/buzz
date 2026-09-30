import assert from "node:assert/strict";
import { test } from "node:test";
import { pendingApprovals } from "./approvalEvents.ts";

const CHANNEL = "11111111-2222-3333-4444-555555555555";

function event(kind, id, createdAt, tags, content = "") {
  return {
    id,
    kind,
    pubkey: "ee".repeat(32),
    created_at: createdAt,
    tags,
    content,
  };
}

function request(id, ref, run, createdAt, content = "approve the prune step") {
  return event(
    46010,
    id,
    createdAt,
    [
      ["d", "wf-1"],
      ["h", CHANNEL],
      ["run", run],
      ["step", "prune"],
      ["approval", ref],
    ],
    content,
  );
}

test("a grant with the same approval tag clears the 46010; a grant for another ref does not", () => {
  // Two gates in the SAME run: the run tag cannot tell them apart.
  const events = [
    request("r1", "ref-a", "run-1", 100),
    request("r2", "ref-b", "run-1", 110),
    event(46011, "g1", 120, [
      ["d", "wf-1"],
      ["h", CHANNEL],
      ["run", "run-1"],
      ["approval", "ref-a"],
    ]),
  ];
  const pending = pendingApprovals(events);
  assert.equal(pending.length, 1, "exactly one gate is still open");
  assert.equal(pending[0].ref, "ref-b");
  assert.equal(pending[0].eventId, "r2");
  assert.equal(pending[0].channelId, CHANNEL);
  assert.equal(pending[0].text, "approve the prune step");

  // A denial clears its own ref just the same.
  const denied = pendingApprovals([
    ...events,
    event(46012, "d1", 130, [["approval", "ref-b"]]),
  ]);
  assert.deepEqual(denied, []);
});

test("requests without a ref are dropped and a NIP-40 expiration is read", () => {
  const pending = pendingApprovals([
    event(46010, "x", 100, [["run", "run-9"]], "no ref, no button"),
    event(
      46010,
      "y",
      200,
      [
        ["approval", "ref-y"],
        ["expiration", "5000"],
      ],
      "  spaced  ",
    ),
  ]);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].ref, "ref-y");
  assert.equal(pending[0].expiresAt, 5000);
  assert.equal(pending[0].text, "spaced");
  assert.equal(pending[0].channelId, null);
});
