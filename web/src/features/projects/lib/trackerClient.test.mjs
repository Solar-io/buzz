/**
 * Tracker sidecar client conformance. The sidecar is a hand-maintained
 * document owned outside this repo (Dwight's ledger), so these assertions
 * pin two things: the join contract (slug/name keys, "done" closes), and the
 * failure posture (malformed input degrades to "no tracker data", never an
 * exception that could take the projects page down with it).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildTrackerIndex,
  fetchTrackerDocument,
  lookupTrackerEntry,
  parseTrackerDocument,
  trackerJsonUrl,
} from "./trackerClient.ts";

const DOCUMENT = {
  version: 1,
  generated: "2026-09-15T19:30:00Z",
  projects: [{ slug: "buzz", owner: "Gilfoyle" }],
  items: [
    {
      id: "D-013",
      project: "buzz",
      kind: "bug",
      status: "in-progress",
      owner: "Richard Hendricks",
      summary: "STT cleanup",
    },
    {
      id: "D-014",
      project: "buzz",
      kind: "feature",
      status: "done",
      owner: "Gilfoyle",
      summary: "Shipped already",
    },
  ],
};

test("parses a well-formed document", () => {
  const doc = parseTrackerDocument(DOCUMENT);
  assert.ok(doc);
  assert.equal(doc.generated, "2026-09-15T19:30:00Z");
  assert.equal(doc.projects.length, 1);
  assert.equal(doc.items.length, 2);
});

test("rejects non-documents with null, never an exception", () => {
  assert.equal(parseTrackerDocument(null), null);
  assert.equal(parseTrackerDocument("buzz"), null);
  assert.equal(parseTrackerDocument({ version: 1 }), null);
  assert.equal(parseTrackerDocument([]), null);
});

test("drops malformed entries instead of failing the document", () => {
  const doc = parseTrackerDocument({
    projects: [{ slug: "buzz", owner: "Gilfoyle" }, { slug: "" }, 7, null],
    items: [
      { id: "D-001", project: "buzz", summary: "no status or kind at all" },
      { project: "buzz", summary: "missing id" },
      "not an object",
    ],
  });
  assert.ok(doc);
  assert.equal(doc.projects.length, 1);
  assert.equal(doc.items.length, 1);
  assert.equal(doc.items[0].status, "open");
  assert.equal(doc.items[0].kind, "task");
});

test("an empty document parses to empty lists", () => {
  const doc = parseTrackerDocument({ projects: [], items: [] });
  assert.ok(doc);
  assert.equal(doc.projects.length, 0);
  assert.equal(doc.items.length, 0);
});

test("joins an item to the registry card by d slug", () => {
  const index = buildTrackerIndex(parseTrackerDocument(DOCUMENT));
  const entry = lookupTrackerEntry(index, { dtag: "buzz", name: "Buzz" });
  assert.ok(entry);
  assert.equal(entry.owner, "Gilfoyle");
  assert.equal(entry.openItems.length, 1);
  assert.equal(entry.openItems[0].id, "D-013");
});

test("done is the only closed status; case and whitespace tolerant", () => {
  const doc = parseTrackerDocument({
    projects: [{ slug: "buzz", owner: "Gilfoyle" }],
    items: [
      { id: "A", project: "buzz", status: " Done ", summary: "x" },
      { id: "B", project: "buzz", status: "DONE", summary: "x" },
      { id: "C", project: "buzz", status: "shipped", summary: "x" },
      { id: "D", project: "buzz", summary: "x" },
    ],
  });
  const entry = lookupTrackerEntry(buildTrackerIndex(doc), {
    dtag: "buzz",
    name: "Buzz",
  });
  assert.ok(entry);
  // "shipped" and the statusless item are NOT done — they stay open. A
  // synonym list here would silently close real work.
  assert.deepEqual(
    entry.openItems.map((item) => item.id).sort(),
    ["C", "D"],
  );
});

test("cites by display name still join to the slug-keyed card", () => {
  // crypto-tracker is the discriminating shape: dtag ≠ lowercase(display
  // name). Without the registry pairing the name-cited item lands on its own
  // island entry, splitting ownership and losing the count.
  const doc = parseTrackerDocument({
    projects: [{ slug: "crypto-tracker", owner: "Gilfoyle" }],
    items: [
      { id: "A", project: "Crypto Tracker", summary: "cited by display name" },
    ],
  });
  const index = buildTrackerIndex(doc, [
    { dtag: "crypto-tracker", name: "Crypto Tracker" },
  ]);
  const entry = lookupTrackerEntry(index, {
    dtag: "crypto-tracker",
    name: "Crypto Tracker",
  });
  assert.ok(entry);
  assert.equal(entry.owner, "Gilfoyle");
  assert.equal(entry.openItems.length, 1);
  assert.equal(entry.openItems[0].id, "A");
});

test("without the registry pairing, name islands stay separate — documented boundary", () => {
  const doc = parseTrackerDocument({
    projects: [{ slug: "crypto-tracker", owner: "Gilfoyle" }],
    items: [
      { id: "A", project: "Crypto Tracker", summary: "cited by display name" },
    ],
  });
  // No registry passed: the slug entry stands alone (owner kept, item
  // unreachable from it). The pairing is the caller's job; this pins that
  // the fusion does not happen by accident.
  const index = buildTrackerIndex(doc);
  const entry = lookupTrackerEntry(index, {
    dtag: "crypto-tracker",
    name: "Crypto Tracker",
  });
  assert.ok(entry);
  assert.equal(entry.owner, "Gilfoyle");
  assert.equal(entry.openItems.length, 0);
});

test("an item owner only fills an empty entry, never overrides the declared primary", () => {
  const doc = parseTrackerDocument({
    projects: [{ slug: "buzz", owner: "Gilfoyle" }],
    items: [{ id: "A", project: "buzz", owner: "Dinesh", summary: "x" }],
  });
  const index = buildTrackerIndex(doc);
  const entry = lookupTrackerEntry(index, { dtag: "buzz", name: "Buzz" });
  assert.ok(entry);
  assert.equal(entry.owner, "Gilfoyle");
});

test("an undeclared project with owner-carrying items gets that owner", () => {
  const doc = parseTrackerDocument({
    items: [{ id: "A", project: "thunk", owner: "Dinesh", summary: "x" }],
  });
  const entry = lookupTrackerEntry(buildTrackerIndex(doc), {
    dtag: "thunk",
    name: "Thunk",
  });
  assert.ok(entry);
  assert.equal(entry.owner, "Dinesh");
  assert.equal(entry.openItems.length, 1);
});

test("a declared project with zero open items still answers with its owner", () => {
  const doc = parseTrackerDocument({
    projects: [{ slug: "meterbar", owner: "Richard Hendricks" }],
    items: [],
  });
  const entry = lookupTrackerEntry(buildTrackerIndex(doc), {
    dtag: "meterbar",
    name: "MeterBar",
  });
  assert.ok(entry);
  assert.equal(entry.owner, "Richard Hendricks");
  assert.equal(entry.openItems.length, 0);
});

test("a project the sidecar never mentions answers null", () => {
  const index = buildTrackerIndex(parseTrackerDocument(DOCUMENT));
  assert.equal(
    lookupTrackerEntry(index, { dtag: "cineiq", name: "CineIQ" }),
    null,
  );
  assert.equal(lookupTrackerEntry(null, { dtag: "buzz", name: "Buzz" }), null);
});

test("case-variant citations of one project fold into a single entry", () => {
  const doc = parseTrackerDocument({
    projects: [
      { slug: "sift", owner: "Gilfoyle" },
      { slug: "SIFT", owner: "Dinesh" },
    ],
    items: [
      { id: "A", project: "SIFT", summary: "cited in caps" },
      { id: "B", project: "sift", summary: "cited lowercase" },
    ],
  });
  const index = buildTrackerIndex(doc);
  // "sift" and "SIFT" are the same project cited two ways — one entry under
  // both keys, or the card would double-count its own items. First declared
  // owner wins.
  const byLower = index.byProject.get("sift");
  const byExact = index.byProject.get("SIFT");
  assert.ok(byLower);
  assert.equal(byLower, byExact);
  assert.equal(byLower.owner, "Gilfoyle");
  assert.equal(byLower.openItems.length, 2);
});

test("fetch failures resolve to null, never a throw", async () => {
  assert.equal(await fetchTrackerDocument("://not-a-url"), null);
});

test("no browser location and no override env means no URL, not a crash", () => {
  // Under the node test runner there is no `location`; the URL derivation
  // must yield null rather than "https://undefined:6451/...".
  assert.equal(trackerJsonUrl(), null);
});

test("a registry pair the sidecar never mentions answers null, not an empty entry", () => {
  // The projects page passes every card's dtag/name through the fusion loop;
  // an entry created there would put a false "Primary: unassigned" on cards
  // the ledger says nothing about. Caught in the live DOM 9/15: all 31 cards
  // rendered Primary before this rule existed.
  const doc = parseTrackerDocument({
    projects: [{ slug: "buzz", owner: "Gilfoyle" }],
    items: [],
  });
  const index = buildTrackerIndex(doc, [
    { dtag: "buzz", name: "Buzz" },
    { dtag: "warranty", name: "Warranty" },
  ]);
  assert.ok(lookupTrackerEntry(index, { dtag: "buzz", name: "Buzz" }));
  assert.equal(
    lookupTrackerEntry(index, { dtag: "warranty", name: "Warranty" }),
    null,
  );
});
