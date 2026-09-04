import assert from "node:assert/strict";
import { test } from "node:test";
import {
  archiveFileName,
  archiveMimeType,
  authorLabel,
  buildArchiveJson,
  isProseKind,
  serializeArchive,
  serializeArchiveJson,
  serializeTranscriptMarkdown,
  slugifyChannelName,
  transcriptEntry,
  utcDay,
  utcTime,
} from "./exportFormat.ts";

const BOUNDS = { maxEvents: 20000, maxPages: 400 };

// 2026-03-04T05:06:07Z
const T = 1772600767;

function ev(overrides = {}) {
  return {
    id: "1".repeat(64),
    pubkey: "ab".repeat(32),
    created_at: T,
    kind: 9,
    tags: [["h", "chan-1"]],
    content: "hello",
    sig: "cd".repeat(64),
    ...overrides,
  };
}

function context(overrides = {}) {
  return {
    channelId: "chan-1",
    channelName: "general",
    relayUrl: "wss://relay.example/",
    exportedAt: T,
    kinds: [9, 40002],
    bounds: BOUNDS,
    reason: "complete",
    sameTimestampPages: 0,
    ...overrides,
  };
}

// ── time helpers ────────────────────────────────────────────────────────────

test("utcDay and utcTime read the fixture timestamp in UTC", () => {
  assert.equal(utcDay(T), "2026-03-04");
  assert.equal(utcTime(T), "05:06:07");
});

// ── filename derivation ─────────────────────────────────────────────────────

test("a plain channel name slugifies to itself", () => {
  assert.equal(slugifyChannelName("general"), "general");
});

test("spaces, punctuation and case collapse into a single separator", () => {
  assert.equal(
    slugifyChannelName("  Product   Design / UX! "),
    "product-design-ux",
  );
});

test("a name with nothing filename-safe falls back rather than emptying", () => {
  assert.equal(slugifyChannelName("🔥🔥🔥"), "channel");
  assert.equal(slugifyChannelName(""), "channel");
  assert.equal(slugifyChannelName("---"), "channel");
});

test("a very long name is capped and never ends in a separator", () => {
  const slug = slugifyChannelName(`${"a".repeat(60)} tail`);
  assert.equal(slug.length, 48);
  assert.doesNotMatch(slug, /-$/);
});

test("the filename carries the channel, the export date and the extension", () => {
  assert.equal(
    archiveFileName("Product Design", T, "json"),
    "buzz-product-design-2026-03-04.json",
  );
  assert.equal(
    archiveFileName("Product Design", T, "markdown"),
    "buzz-product-design-2026-03-04.md",
  );
});

test("each format declares its own MIME type", () => {
  assert.match(archiveMimeType("json"), /^application\/json/);
  assert.match(archiveMimeType("markdown"), /^text\/markdown/);
});

// ── JSON archive ────────────────────────────────────────────────────────────

test("the JSON archive keeps every signed field the relay served", () => {
  const event = ev();
  const archive = buildArchiveJson([event], context());
  assert.equal(archive.events.length, 1);
  assert.deepEqual(archive.events[0], event, "no field is stripped");
  assert.equal(archive.events[0].sig, event.sig, "the signature survives");
  assert.deepEqual(archive.events[0].tags, event.tags, "tags survive");
});

test("the envelope names the channel, relay, kinds and export time", () => {
  const archive = buildArchiveJson([ev()], context());
  assert.equal(archive.buzzArchiveVersion, 1);
  assert.deepEqual(archive.channel, { id: "chan-1", name: "general" });
  assert.equal(archive.relay, "wss://relay.example/");
  assert.equal(archive.exportedAt, "2026-03-04T05:06:07.000Z");
  assert.deepEqual(archive.kinds, [9, 40002]);
  assert.equal(archive.eventCount, 1);
});

test("a truncated archive says so — complete is false and explained", () => {
  const archive = buildArchiveJson([ev()], context({ reason: "max-events" }));
  assert.equal(archive.complete, false);
  assert.match(archive.completeness, /Truncated/);
});

test("a finished archive says complete", () => {
  const archive = buildArchiveJson([ev()], context());
  assert.equal(archive.complete, true);
  assert.match(archive.completeness, /^Complete/);
});

test("timestamp-saturated pages surface as a warning, and are absent otherwise", () => {
  const clean = buildArchiveJson([ev()], context());
  assert.equal(
    clean.warnings,
    undefined,
    "no warnings key when nothing to warn",
  );
  const warned = buildArchiveJson([ev()], context({ sameTimestampPages: 2 }));
  assert.equal(warned.warnings.length, 1);
  assert.match(warned.warnings[0], /2 page/);
});

test("the serialised JSON parses back to the same archive", () => {
  const events = [ev({ id: "a".repeat(64), created_at: T - 60 }), ev()];
  const text = serializeArchiveJson(events, context());
  const parsed = JSON.parse(text);
  assert.equal(parsed.eventCount, 2);
  assert.deepEqual(parsed.events, events);
  assert.match(text, /\n$/, "the file ends with a newline");
});

// ── transcript ──────────────────────────────────────────────────────────────

test("prose kinds and bookkeeping kinds are told apart", () => {
  for (const kind of [9, 40002, 45001, 45003]) {
    assert.equal(isProseKind(kind), true, `kind ${kind} is prose`);
  }
  for (const kind of [5, 7, 40003, 40099]) {
    assert.equal(isProseKind(kind), false, `kind ${kind} is not prose`);
  }
});

test("a resolved name beats the truncated pubkey", () => {
  const names = new Map([["ab".repeat(32), "Alice"]]);
  assert.equal(authorLabel("ab".repeat(32), names), "Alice");
});

test("an unresolved or blank name falls back to a truncated pubkey", () => {
  const pubkey = "ab".repeat(32);
  assert.equal(authorLabel(pubkey, new Map()), "abababab…abab");
  assert.equal(
    authorLabel(pubkey, new Map([[pubkey, "   "]])),
    "abababab…abab",
  );
});

test("a prose entry renders the author, the UTC time and the body verbatim", () => {
  const entry = transcriptEntry(
    ev({ content: "line one\nline two" }),
    new Map([["ab".repeat(32), "Alice"]]),
  );
  assert.equal(entry, "**05:06:07 · Alice**\n\nline one\nline two");
});

test("an empty prose body is marked rather than rendering as blank", () => {
  assert.match(
    transcriptEntry(ev({ content: "" }), new Map()),
    /empty message/,
  );
});

test("a non-prose event is summarised, not dropped", () => {
  const entry = transcriptEntry(
    ev({ kind: 7, content: "🔥" }),
    new Map([["ab".repeat(32), "Alice"]]),
  );
  assert.equal(entry, "_05:06:07 · Alice · kind 7 — 🔥_");
});

test("a long non-prose body is clipped so one event cannot flood the file", () => {
  const entry = transcriptEntry(
    ev({ kind: 5, content: "x".repeat(500) }),
    new Map(),
  );
  assert.ok(entry.length < 220, `entry was ${entry.length} chars`);
});

test("the transcript groups events under one heading per UTC day", () => {
  const day1 = ev({ id: "a".repeat(64), created_at: T, content: "first" });
  const day1b = ev({
    id: "b".repeat(64),
    created_at: T + 60,
    content: "second",
  });
  const day2 = ev({
    id: "c".repeat(64),
    created_at: T + 86_400,
    content: "third",
  });
  const text = serializeTranscriptMarkdown([day1, day1b, day2], context());
  const headings = text.match(/^## .*$/gm);
  assert.deepEqual(headings, ["## 2026-03-04", "## 2026-03-05"]);
  assert.ok(text.includes("first"));
  assert.ok(text.includes("second"));
  assert.ok(text.includes("third"));
});

test("the transcript header states the channel, relay and completeness", () => {
  const text = serializeTranscriptMarkdown(
    [ev()],
    context({ reason: "max-pages" }),
  );
  assert.match(text, /^# general$/m);
  assert.match(text, /- Relay: wss:\/\/relay\.example\/$/m);
  assert.match(text, /- Channel id: `chan-1`$/m);
  assert.match(text, /- Completeness: Truncated at the 400-page ceiling/m);
});

test("an empty export still produces a readable header-only transcript", () => {
  const text = serializeTranscriptMarkdown([], context());
  assert.match(text, /- Events: 0 \(kinds 9, 40002\)/);
  assert.equal(text.match(/^## /gm), null, "no day headings without events");
});

// ── format dispatch ─────────────────────────────────────────────────────────

test("serializeArchive dispatches to the format the caller asked for", () => {
  const events = [ev()];
  assert.equal(
    serializeArchive("json", events, context()),
    serializeArchiveJson(events, context()),
  );
  const names = new Map([["ab".repeat(32), "Alice"]]);
  assert.equal(
    serializeArchive("markdown", events, context(), names),
    serializeTranscriptMarkdown(events, context(), names),
  );
});

test("the two formats are genuinely different documents", () => {
  const events = [ev()];
  const json = serializeArchive("json", events, context());
  const markdown = serializeArchive("markdown", events, context());
  assert.notEqual(json, markdown);
  assert.ok(json.includes('"sig"'), "JSON carries the signature");
  assert.ok(!markdown.includes("cdcdcd"), "the transcript does not");
});
