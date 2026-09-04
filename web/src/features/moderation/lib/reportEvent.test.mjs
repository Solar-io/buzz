import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildReportEvent,
  KIND_REPORT,
  REPORT_CATEGORIES,
  REPORT_TYPES,
} from "./reportEvent.ts";

const AUTHOR = "ab".repeat(32);
const EVENT_ID = "cd".repeat(32);

// Hardcoded, never derived from the constant under test: an assertion phrased
// as `KIND_REPORT === KIND_REPORT` cannot fail.
test("reports are published as NIP-56 kind 1984", () => {
  assert.equal(KIND_REPORT, 1984);
  assert.equal(
    buildReportEvent({
      authorPubkey: AUTHOR,
      eventId: EVENT_ID,
      reportType: "spam",
    }).kind,
    1984,
  );
});

test("the vocabulary matches report.rs REPORT_TYPES exactly", () => {
  // Order and membership both matter: the relay compares by membership, but a
  // silent addition here would ship a picker entry ingest rejects.
  assert.deepEqual(
    [...REPORT_TYPES],
    [
      "illegal",
      "nudity",
      "malware",
      "spam",
      "impersonation",
      "profanity",
      "other",
    ],
  );
});

test("every picker category is an accepted report type, and all are covered", () => {
  for (const category of REPORT_CATEGORIES) {
    assert.ok(
      REPORT_TYPES.includes(category.value),
      `category ${category.value} is not an accepted report type`,
    );
  }
  assert.equal(
    REPORT_CATEGORIES.length,
    REPORT_TYPES.length,
    "every accepted report type needs a picker entry",
  );
  // `other` reads as the fallback, so it must be last.
  assert.equal(REPORT_CATEGORIES.at(-1).value, "other");
});

test("an event report carries exactly one p tag and one type-bearing e tag", () => {
  const built = buildReportEvent({
    authorPubkey: AUTHOR,
    eventId: EVENT_ID,
    reportType: "impersonation",
  });

  // parse_report: `p_tags.len() > 1` is rejected outright.
  assert.equal(built.tags.filter((tag) => tag[0] === "p").length, 1);
  assert.equal(built.tags.filter((tag) => tag[0] === "e").length, 1);

  const pTag = built.tags.find((tag) => tag[0] === "p");
  const eTag = built.tags.find((tag) => tag[0] === "e");

  assert.deepEqual(pTag, ["p", AUTHOR]);
  // The report TYPE rides the e tag's third element — parse_report reads
  // `fields.get(2)` on the target tag, and a type on the p tag would be
  // ignored for an e-target report.
  assert.deepEqual(eTag, ["e", EVENT_ID, "impersonation"]);
  assert.equal(pTag.length, 2, "the p tag must not carry a report type");
});

test("the report type is the caller's choice, not a fixed value", () => {
  // Discriminating on purpose: a builder that hardcoded one type would pass a
  // single-type assertion. Every accepted type must survive the round trip.
  for (const type of REPORT_TYPES) {
    const built = buildReportEvent({
      authorPubkey: AUTHOR,
      eventId: EVENT_ID,
      reportType: type,
    });
    assert.equal(built.tags.find((tag) => tag[0] === "e")[2], type);
  }
});

test("the note becomes the event content, trimmed; absent means empty", () => {
  assert.equal(
    buildReportEvent({
      authorPubkey: AUTHOR,
      eventId: EVENT_ID,
      reportType: "spam",
      note: "  posted the same link ten times  ",
    }).content,
    "posted the same link ten times",
  );
  // report.rs `report_note` maps empty content to None — whitespace-only must
  // not become a blank note row.
  assert.equal(
    buildReportEvent({
      authorPubkey: AUTHOR,
      eventId: EVENT_ID,
      reportType: "spam",
      note: "   ",
    }).content,
    "",
  );
  assert.equal(
    buildReportEvent({
      authorPubkey: AUTHOR,
      eventId: EVENT_ID,
      reportType: "spam",
    }).content,
    "",
  );
});

test("hex targets are normalized to lower case", () => {
  const built = buildReportEvent({
    authorPubkey: AUTHOR.toUpperCase(),
    eventId: ` ${EVENT_ID.toUpperCase()} `,
    reportType: "malware",
  });
  assert.deepEqual(built.tags[0], ["p", AUTHOR]);
  assert.deepEqual(built.tags[1], ["e", EVENT_ID, "malware"]);
});

test("malformed targets throw instead of shipping an invalid report", () => {
  assert.throws(
    () =>
      buildReportEvent({
        authorPubkey: "not-hex",
        eventId: EVENT_ID,
        reportType: "spam",
      }),
    /author pubkey/,
  );
  assert.throws(
    () =>
      buildReportEvent({
        authorPubkey: AUTHOR,
        eventId: "ab".repeat(31),
        reportType: "spam",
      }),
    /event id/,
  );
});

test("an unsupported report type is refused before it reaches the relay", () => {
  assert.throws(
    () =>
      buildReportEvent({
        authorPubkey: AUTHOR,
        eventId: EVENT_ID,
        reportType: "phishing",
      }),
    /Unsupported report type/,
  );
});
