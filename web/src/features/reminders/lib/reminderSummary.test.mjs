import assert from "node:assert/strict";
import { test } from "node:test";

import {
  displayText,
  fetchReminderSummary,
  parseSummaryResponse,
  summaryBridgeUrl,
  summaryInputFor,
} from "./reminderSummary.ts";

/**
 * Every expected string here is a HARDCODED literal, never derived from the
 * length constants under test — so moving a threshold or the truncation
 * point fails a named test instead of silently moving the expectation.
 */

// 176 chars: over the 160-char "show as-is" threshold.
const LONG =
  "The relay deploy failed last night because migration 0042 timed out on a lock held by the analytics job. Please review the draft PR and tell me by Thursday whether to rerun it.";
// 160 chars exactly: at the threshold, shown as-is.
const AT_THRESHOLD = "x".repeat(160);
const SECRET_NOTE = "PRIVATE-NOTE-do-not-send-4f2a";

function reminder({ preview, note } = {}) {
  return {
    id: "d1",
    notBefore: 1_800_000_000,
    createdAt: 1_700_000_000,
    eventId: "e1",
    content: {
      status: "pending",
      ...(note === undefined ? {} : { note }),
      ...(preview === undefined
        ? {}
        : {
            target: {
              eventId: "m1",
              channelId: "c1",
              preview,
              authorPubkey: "a".repeat(64),
            },
          }),
    },
  };
}

function stubFetch(reply, status = 200) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => reply,
    };
  };
  return { impl, calls };
}

test("summaryBridgeUrl builds the 6368 https endpoint from the served hostname", () => {
  assert.equal(
    summaryBridgeUrl("crichton.tailb3d4b8.ts.net"),
    "https://crichton.tailb3d4b8.ts.net:6368/summarize",
  );
});

test("summaryInputFor: no preview or a short preview needs no summary", () => {
  assert.equal(summaryInputFor(reminder({ note: "just a note" })), null);
  assert.equal(summaryInputFor(reminder({ preview: "   " })), null);
  assert.equal(summaryInputFor(reminder({ preview: "short message" })), null);
  assert.equal(summaryInputFor(reminder({ preview: AT_THRESHOLD })), null);
  assert.equal(
    summaryInputFor(reminder({ preview: `${AT_THRESHOLD}y` })),
    `${AT_THRESHOLD}y`,
  );
  assert.equal(summaryInputFor(reminder({ preview: LONG })), LONG);
});

test("the note is never in the request body — only the preview is sent", async () => {
  const { impl, calls } = stubFetch({ summary: "Deploy failed; rerun?" });
  const result = await fetchReminderSummary(
    reminder({ preview: LONG, note: SECRET_NOTE }),
    "https://h:6368/summarize",
    impl,
  );
  assert.equal(result, "Deploy failed; rerun?");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.body.includes(SECRET_NOTE), false);
  assert.deepEqual(JSON.parse(calls[0].init.body), { text: LONG });
});

test("a short preview makes no request at all", async () => {
  const { impl, calls } = stubFetch({ summary: "unused" });
  const result = await fetchReminderSummary(
    reminder({ preview: "short message", note: SECRET_NOTE }),
    "https://h:6368/summarize",
    impl,
  );
  assert.equal(result, null);
  assert.equal(calls.length, 0);
});

test("fetchReminderSummary rejects on non-2xx and on a malformed reply", async () => {
  await assert.rejects(
    fetchReminderSummary(
      reminder({ preview: LONG }),
      "u",
      stubFetch({ error: "x" }, 502).impl,
    ),
  );
  await assert.rejects(
    fetchReminderSummary(
      reminder({ preview: LONG }),
      "u",
      stubFetch({ nope: 1 }).impl,
    ),
  );
});

test("parseSummaryResponse rejects malformed shapes", () => {
  assert.equal(parseSummaryResponse(null), null);
  assert.equal(parseSummaryResponse("a summary"), null);
  assert.equal(parseSummaryResponse(["a summary"]), null);
  assert.equal(parseSummaryResponse({}), null);
  assert.equal(parseSummaryResponse({ summary: 42 }), null);
  assert.equal(parseSummaryResponse({ summary: "   " }), null);
  assert.equal(
    parseSummaryResponse({
      summary: "  Deploy failed. ",
      model: "m",
      cached: true,
    }),
    "Deploy failed.",
  );
});

test("displayText: loading and error show the preview cut to 140 chars + ellipsis", () => {
  const expected = {
    text: "The relay deploy failed last night because migration 0042 timed out on a lock held by the analytics job. Please review the draft PR and tell…",
    isSummary: false,
  };
  assert.deepEqual(
    displayText(reminder({ preview: LONG }), { status: "loading" }),
    expected,
  );
  assert.deepEqual(
    displayText(reminder({ preview: LONG }), { status: "error" }),
    expected,
  );
});

test("displayText: ready shows the summary, flagged as AI", () => {
  assert.deepEqual(
    displayText(reminder({ preview: LONG, note: SECRET_NOTE }), {
      status: "ready",
      summary:
        "Deploy failed on migration 0042; asks whether to rerun by Thursday.",
    }),
    {
      text: "Deploy failed on migration 0042; asks whether to rerun by Thursday.",
      isSummary: true,
    },
  );
});

test("displayText: a short preview is shown verbatim; no preview → null", () => {
  assert.deepEqual(
    displayText(reminder({ preview: "short message" }), { status: "loading" }),
    {
      text: "short message",
      isSummary: false,
    },
  );
  assert.equal(
    displayText(reminder({ note: "only a note" }), { status: "loading" }),
    null,
  );
});
