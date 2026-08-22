import assert from "node:assert/strict";
import test from "node:test";

import {
  dominantToolRunBucket,
  isToolRunEligible,
  summarizeToolRunHeadline,
  summarizeToolRunStatus,
  TOOL_RUN_MINIMUM_STEPS,
  toolRunCompletedAtMs,
  toolRunElapsedMs,
  toolRunGroupKey,
  toolRunStartedAtMs,
} from "./agentSessionToolRunSummary.ts";

const START = "2026-06-18T00:00:00.000Z";
const START_MS = Date.parse(START);

function tool(id, renderClass, overrides = {}) {
  return {
    id,
    type: "tool",
    renderClass,
    descriptor: {
      renderClass,
      label: "Ran tool",
      preview: id,
      source: "harness",
      groupKey: renderClass,
    },
    title: id,
    toolName: id,
    buzzToolName: null,
    status: "completed",
    args: {},
    result: "",
    isError: false,
    timestamp: START,
    startedAt: START,
    completedAt: "2026-06-18T00:00:01.000Z",
    turnId: "turn-1",
    sessionId: "sess-1",
    channelId: "chan-1",
    ...overrides,
  };
}

function headlineOf(items) {
  return summarizeToolRunHeadline(items, summarizeToolRunStatus(items));
}

// ── Eligibility ──────────────────────────────────────────────────────────────

test("isToolRunEligible admits ordinary tool work", () => {
  for (const renderClass of [
    "file-read",
    "file-edit",
    "relay-op",
    "skill-read",
    "message",
    "generic",
    "image",
    "shell",
    "plan",
  ]) {
    assert.equal(isToolRunEligible(tool("t", renderClass)), true, renderClass);
  }
});

// The safety net and every intervention point must stay visible as its own row.
test("isToolRunEligible refuses raw-rail, suppressed, status, permission, thought", () => {
  for (const renderClass of [
    "raw-rail",
    "suppressed",
    "status",
    "permission",
    "thought",
  ]) {
    assert.equal(isToolRunEligible(tool("t", renderClass)), false, renderClass);
  }
});

test("isToolRunEligible admits a failed step so it stays in its own run", () => {
  assert.equal(
    isToolRunEligible(tool("t", "error", { isError: true, status: "failed" })),
    true,
  );
  assert.equal(
    isToolRunEligible(tool("t", "shell", { isError: true, status: "failed" })),
    true,
  );
});

test("isToolRunEligible refuses non-tool items", () => {
  assert.equal(
    isToolRunEligible({
      id: "m",
      type: "message",
      renderClass: "message",
      role: "assistant",
      title: "Assistant",
      text: "hi",
      timestamp: START,
    }),
    false,
  );
});

test("isToolRunEligible falls back to the descriptor render class", () => {
  const item = tool("t", undefined);
  item.renderClass = undefined;
  item.descriptor.renderClass = "shell";
  assert.equal(isToolRunEligible(item), true);

  const suppressed = tool("t2", undefined);
  suppressed.renderClass = undefined;
  suppressed.descriptor.renderClass = "suppressed";
  assert.equal(isToolRunEligible(suppressed), false);
});

test("toolRunGroupKey prefers the descriptor groupKey, falling back to the class", () => {
  assert.equal(
    toolRunGroupKey(
      tool("t", "file-read", {
        descriptor: {
          renderClass: "file-read",
          label: "Read file",
          preview: null,
          groupKey: "read_file",
        },
      }),
    ),
    "read_file",
  );
  assert.equal(
    toolRunGroupKey(
      tool("t", "file-read", {
        descriptor: {
          renderClass: "file-read",
          label: "Read file",
          preview: null,
        },
      }),
    ),
    "file-read",
  );
});

test("TOOL_RUN_MINIMUM_STEPS keeps a lone step out of a card", () => {
  assert.equal(TOOL_RUN_MINIMUM_STEPS, 2);
});

// ── Aggregate status ─────────────────────────────────────────────────────────

test("summarizeToolRunStatus reports done for an all-settled clean run", () => {
  const aggregate = summarizeToolRunStatus([
    tool("a", "shell"),
    tool("b", "shell"),
  ]);
  assert.deepEqual(aggregate, {
    phase: "done",
    hasError: false,
    count: 2,
    activeStep: null,
    errorCount: 0,
  });
});

test("summarizeToolRunStatus reports the FIRST unsettled step as active", () => {
  const aggregate = summarizeToolRunStatus([
    tool("a", "shell"),
    tool("b", "shell", { status: "executing", completedAt: null }),
    tool("c", "shell", { status: "pending", completedAt: null }),
  ]);
  assert.equal(aggregate.phase, "running");
  assert.equal(aggregate.activeStep, 2);
});

test("summarizeToolRunStatus counts failures from isError or failed status", () => {
  const aggregate = summarizeToolRunStatus([
    tool("a", "shell"),
    tool("b", "error", { isError: true }),
    tool("c", "shell", { status: "failed" }),
  ]);
  assert.equal(aggregate.phase, "error");
  assert.equal(aggregate.hasError, true);
  assert.equal(aggregate.errorCount, 2);
});

// A live run keeps reporting that work is ongoing; the failure is not masked —
// hasError stays true so the card stays open and highlights the failing step.
test("summarizeToolRunStatus keeps running phase while a failed step is followed by live work", () => {
  const aggregate = summarizeToolRunStatus([
    tool("a", "error", { isError: true }),
    tool("b", "shell", { status: "executing", completedAt: null }),
  ]);
  assert.equal(aggregate.phase, "running");
  assert.equal(aggregate.hasError, true);
});

// ── Headlines ────────────────────────────────────────────────────────────────

test("summarizeToolRunHeadline keeps the specific countable sentence for a homogeneous run", () => {
  const read = (id) =>
    tool(id, "file-read", {
      descriptor: {
        renderClass: "file-read",
        label: "Read file",
        preview: null,
        groupKey: "read_file",
      },
    });

  assert.deepEqual(headlineOf([read("a"), read("b"), read("c")]), {
    verb: "Read",
    object: "3 files",
    detail: null,
  });
});

test("summarizeToolRunHeadline names each homogeneous run class", () => {
  const homogeneous = (renderClass, groupKey) =>
    [1, 2].map((n) =>
      tool(`${renderClass}-${n}`, renderClass, {
        descriptor: { renderClass, label: "Label", preview: null, groupKey },
      }),
    );

  assert.deepEqual(headlineOf(homogeneous("file-edit", "edit")), {
    verb: "Edited",
    object: "2 files",
    detail: null,
  });
  assert.deepEqual(headlineOf(homogeneous("skill-read", "skill")), {
    verb: "Read",
    object: "2 skills",
    detail: null,
  });
  assert.deepEqual(headlineOf(homogeneous("shell", "cmd")), {
    verb: "Ran",
    object: "2 commands",
    detail: null,
  });
  assert.deepEqual(headlineOf(homogeneous("relay-op", "relay")), {
    verb: "Ran",
    object: "2 Buzz relay ops",
    detail: null,
  });
  assert.deepEqual(headlineOf(homogeneous("message", "msg")), {
    verb: "Sent",
    object: "2 messages",
    detail: null,
  });
  assert.deepEqual(headlineOf(homogeneous("image", "img")), {
    verb: "Viewed",
    object: "2 images",
    detail: null,
  });
});

test("summarizeToolRunHeadline falls back to the descriptor label for an unnamed homogeneous run", () => {
  const generic = (id) =>
    tool(id, "generic", {
      descriptor: {
        renderClass: "generic",
        label: "Queried registry",
        preview: null,
        groupKey: "registry",
      },
    });

  assert.deepEqual(headlineOf([generic("a"), generic("b")]), {
    verb: "Queried registry",
    object: "×2",
    detail: null,
  });
});

// A heterogeneous run must not pretend to be one thing: it names the dominant
// kind of work and carries the honest step count.
test("summarizeToolRunHeadline names the dominant bucket and step count for a mixed run", () => {
  const headline = headlineOf([
    tool("read-1", "file-read", {
      descriptor: {
        renderClass: "file-read",
        label: "Read file",
        preview: null,
        groupKey: "read_file",
      },
    }),
    tool("read-2", "file-read", {
      descriptor: {
        renderClass: "file-read",
        label: "Read file",
        preview: null,
        groupKey: "read_file",
      },
    }),
    tool("shell-1", "shell", {
      descriptor: {
        renderClass: "shell",
        label: "Ran command",
        preview: null,
        groupKey: "shell",
      },
    }),
  ]);

  assert.deepEqual(headline, {
    verb: "Read",
    object: "files",
    detail: "3 steps",
  });
});

test("summarizeToolRunHeadline reads as active with the step position while live", () => {
  const headline = headlineOf([
    tool("read-1", "file-read", {
      descriptor: {
        renderClass: "file-read",
        label: "Read file",
        preview: null,
        groupKey: "read_file",
      },
    }),
    tool("read-2", "file-read", {
      descriptor: {
        renderClass: "file-read",
        label: "Read file",
        preview: null,
        groupKey: "read_file",
      },
    }),
    tool("read-3", "file-read", {
      status: "executing",
      completedAt: null,
      descriptor: {
        renderClass: "file-read",
        label: "Read file",
        preview: null,
        groupKey: "read_file",
      },
    }),
  ]);

  assert.deepEqual(headline, {
    verb: "Reviewing",
    object: "files",
    detail: "step 3",
  });
});

test("summarizeToolRunHeadline tolerates an empty run", () => {
  assert.deepEqual(headlineOf([]), {
    verb: "Working…",
    object: null,
    detail: null,
  });
});

// Writes and outbound speech outrank reads when equally common, so a run that
// edited as much as it read headlines as editing.
test("dominantToolRunBucket breaks ties toward the more salient bucket", () => {
  assert.equal(
    dominantToolRunBucket([
      tool("read-1", "file-read"),
      tool("edit-1", "file-edit"),
    ]),
    "edit",
  );
  assert.equal(
    dominantToolRunBucket([
      tool("read-1", "file-read"),
      tool("read-2", "file-read"),
      tool("edit-1", "file-edit"),
    ]),
    "review",
  );
});

test("dominantToolRunBucket reports failed steps as generic tool work", () => {
  assert.equal(
    dominantToolRunBucket([tool("f", "error", { isError: true })]),
    "tool",
  );
});

// ── Timing ───────────────────────────────────────────────────────────────────

test("toolRunStartedAtMs takes the earliest start across the run", () => {
  const items = [
    tool("a", "shell", { startedAt: "2026-06-18T00:00:05.000Z" }),
    tool("b", "shell", { startedAt: START }),
  ];
  assert.equal(toolRunStartedAtMs(items), START_MS);
});

test("toolRunStartedAtMs falls back to the timestamp when startedAt is absent", () => {
  const item = tool("a", "shell", { startedAt: "" });
  assert.equal(toolRunStartedAtMs([item]), START_MS);
});

test("toolRunCompletedAtMs returns null until every step has settled", () => {
  const settled = [
    tool("a", "shell", { completedAt: "2026-06-18T00:00:01.000Z" }),
    tool("b", "shell", { completedAt: "2026-06-18T00:00:04.000Z" }),
  ];
  assert.equal(
    toolRunCompletedAtMs(settled),
    Date.parse("2026-06-18T00:00:04.000Z"),
  );

  const partial = [...settled, tool("c", "shell", { completedAt: null })];
  assert.equal(toolRunCompletedAtMs(partial), null);
});

test("toolRunElapsedMs spans first start to last completion once settled", () => {
  const items = [
    tool("a", "shell", { completedAt: "2026-06-18T00:00:01.000Z" }),
    tool("b", "shell", { completedAt: "2026-06-18T00:00:04.500Z" }),
  ];
  assert.equal(toolRunElapsedMs(items, START_MS + 999_999), 4500);
});

test("toolRunElapsedMs runs to now while a step is unsettled", () => {
  const items = [
    tool("a", "shell", { completedAt: "2026-06-18T00:00:01.000Z" }),
    tool("b", "shell", { status: "executing", completedAt: null }),
  ];
  assert.equal(toolRunElapsedMs(items, START_MS + 2500), 2500);
});

test("toolRunElapsedMs returns null for unmeasurable or negative spans", () => {
  const unparseable = tool("a", "shell", {
    startedAt: "nope",
    timestamp: "nope",
  });
  assert.equal(toolRunElapsedMs([unparseable], START_MS), null);
  assert.equal(toolRunStartedAtMs([unparseable]), null);

  const settled = [
    tool("a", "shell", { completedAt: "2026-06-17T23:59:59.000Z" }),
  ];
  assert.equal(toolRunElapsedMs(settled, START_MS), null);
});
