import assert from "node:assert/strict";
import test from "node:test";

import {
  capturedText,
  summaryLine,
  summaryRequestText,
} from "./itemSummary.ts";

const LONG =
  "Long huddles go silent around the forty minute mark. The jitter buffer runs dry and never recovers, and nothing in the log says why — Chatterbox keeps sending audio the whole time.";
const source = (content, tags = [["h", "c"]]) => ({
  id: "s".repeat(64),
  pubkey: "b".repeat(64),
  created_at: 1,
  content,
  tags,
});
const item = (overrides = {}) => ({
  title: "TTS bridge stalls",
  summary: null,
  body: "",
  ...overrides,
});

test("an item's own summary wins, marked AI only when an agent filed it", () => {
  const own = item({ summary: "  The jitter buffer drains.  " });
  assert.deepEqual(
    summaryLine({
      item: own,
      captured: LONG,
      reporterIsAgent: true,
      state: null,
    }),
    { text: "The jitter buffer drains.", ai: true },
  );
  assert.deepEqual(
    summaryLine({
      item: own,
      captured: LONG,
      reporterIsAgent: false,
      state: null,
    }),
    { text: "The jitter buffer drains.", ai: false },
  );
  // No bridge request when the summary is there.
  assert.equal(summaryRequestText(own, LONG), null);
});

test("short captured text is shown as-is — unless it only repeats the title", () => {
  const short = "Goes silent at 40 min.";
  assert.equal(summaryRequestText(item(), short), null);
  assert.deepEqual(
    summaryLine({
      item: item(),
      captured: short,
      reporterIsAgent: false,
      state: null,
    }),
    { text: short, ai: false },
  );
  assert.equal(
    summaryLine({
      item: item(),
      captured: "tts bridge stalls",
      reporterIsAgent: false,
      state: null,
    }),
    null,
  );
});

test("long captured text goes to the bridge; cut to 140 until it answers", () => {
  assert.ok(LONG.length > 160);
  assert.equal(summaryRequestText(item(), LONG), LONG);
  const loading = summaryLine({
    item: item(),
    captured: LONG,
    reporterIsAgent: false,
    state: { status: "loading" },
  });
  assert.equal(loading.ai, false);
  assert.ok(loading.text.endsWith("…"));
  assert.ok(loading.text.length <= 141);
  assert.deepEqual(
    summaryLine({
      item: item(),
      captured: LONG,
      reporterIsAgent: false,
      state: { status: "ready", summary: "Audio stops after 40 min." },
    }),
    { text: "Audio stops after 40 min.", ai: true },
  );
  assert.equal(
    summaryLine({
      item: item(),
      captured: LONG,
      reporterIsAgent: false,
      state: { status: "error" },
    }).ai,
    false,
  );
});

test("a /bug row is not worth quoting: the body stands in, else nothing", () => {
  const row = source("Filed bug 7f3k2m9qa1bc: TTS bridge stalls", [
    ["h", "c"],
    ["item", "7f3k2m9qa1bc", "bug"],
  ]);
  assert.equal(capturedText(item(), row), null);
  assert.equal(
    capturedText(item({ body: "**Repro:** join a huddle, wait." }), row),
    "Repro: join a huddle, wait.",
  );
  assert.equal(
    capturedText(item(), source("> quoted *message*")),
    "quoted message",
  );
  assert.equal(capturedText(item(), null), null);
  assert.equal(
    summaryLine({
      item: item(),
      captured: null,
      reporterIsAgent: true,
      state: null,
    }),
    null,
  );
});
