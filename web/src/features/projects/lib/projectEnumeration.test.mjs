/**
 * Enumeration must survive a page boundary that lands inside a group of events
 * sharing one `created_at`.
 *
 * The oracle is `exhaustive_enumeration_across_pages_with_tied_timestamps` in
 * docs/nips/NIP-MP.fold-fixtures.json. Its `enumeration` block is the harness
 * contract: serve pages of `page_size` ordered `(created_at DESC, coordinate
 * ASC)`, and page with a composite `(created_at, id)` cursor — coordinate
 * standing in for the event id that unsigned semantic fixtures do not carry.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  enumerateEventsComposite,
  enumerateEventsUntilOnly,
} from "./projectEnumeration.ts";
import { buildProjectReadModels } from "./projectModels.ts";

const foldFixtures = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        "../../../../../docs/nips/NIP-MP.fold-fixtures.json",
        import.meta.url,
      ),
    ),
    "utf8",
  ),
);

const fixture = foldFixtures.cases.find(
  (candidate) =>
    candidate.name ===
    "exhaustive_enumeration_across_pages_with_tied_timestamps",
);

test("the enumeration oracle is present and pages narrower than its inputs", () => {
  assert.ok(fixture, "enumeration fold fixture is missing");
  assert.equal(fixture.enumeration.page_size, 2);
  assert.equal(fixture.enumeration.cursor, "composite");
  assert.equal(fixture.repositories.length, 3);
  assert.equal(fixture.projects.length, 2);
  // Three repositories share one second while a page holds two: without a
  // tiebreak the boundary is unresolvable, which is the whole point of the case.
  assert.ok(fixture.enumeration.page_size < fixture.repositories.length);
  assert.equal(
    new Set(fixture.repositories.map((repo) => repo.created_at)).size,
    1,
  );
});

function splitCoordinate(coordinate) {
  const first = coordinate.indexOf(":");
  const second = coordinate.indexOf(":", first + 1);
  return {
    kind: Number(coordinate.slice(0, first)),
    pubkey: coordinate.slice(first + 1, second),
    dtag: coordinate.slice(second + 1),
  };
}

function fixtureEvents() {
  const events = [];
  for (const repository of fixture.repositories) {
    const { kind, pubkey, dtag } = splitCoordinate(repository.coordinate);
    events.push({
      id: repository.coordinate,
      pubkey,
      kind,
      created_at: repository.created_at,
      content: "",
      tags: [["d", dtag]],
    });
  }
  for (const project of fixture.projects) {
    const { kind, dtag } = splitCoordinate(project.coordinate);
    events.push({
      id: project.coordinate,
      pubkey: project.signer,
      kind,
      created_at: project.created_at,
      content: "",
      tags: [["d", dtag], ...project.members.map((member) => ["a", member])],
    });
  }
  return events;
}

/**
 * A relay honouring the fixture's harness contract.
 *
 * `honourBeforeId: false` reproduces the Buzz websocket, which deserializes a
 * REQ filter into a plain `nostr::Filter` and silently drops `before_id`.
 */
function makeRelay(allEvents, pageSize, { honourBeforeId = true } = {}) {
  const calls = [];
  const fetchPage = async (filter) => {
    calls.push(filter);
    const ordered = allEvents
      .filter((event) => filter.kinds.includes(event.kind))
      .sort(
        (left, right) =>
          right.created_at - left.created_at || left.id.localeCompare(right.id),
      );
    const matched = ordered.filter((event) => {
      if (filter.since !== undefined && event.created_at < filter.since) {
        return false;
      }
      if (filter.until === undefined) return true;
      if (honourBeforeId && filter.before_id !== undefined) {
        return (
          event.created_at < filter.until ||
          (event.created_at === filter.until && event.id > filter.before_id)
        );
      }
      return event.created_at <= filter.until;
    });
    return matched.slice(0, Math.min(filter.limit, pageSize));
  };
  return { calls, fetchPage };
}

test("mode 1 collects every head across pages with tied timestamps", async () => {
  const allEvents = fixtureEvents();
  const pageSize = fixture.enumeration.page_size;

  const repoRelay = makeRelay(allEvents, pageSize);
  const repositories = await enumerateEventsComposite(
    repoRelay.fetchPage,
    [30617],
    pageSize,
  );
  const projectRelay = makeRelay(allEvents, pageSize);
  const projects = await enumerateEventsComposite(
    projectRelay.fetchPage,
    [30621],
    pageSize,
  );

  assert.equal(repositories.events.length, 3);
  assert.equal(repositories.possiblyIncomplete, false);
  assert.equal(projects.events.length, 2);
  assert.ok(
    repoRelay.calls.length > 1,
    `expected more than one page, got ${repoRelay.calls.length}`,
  );
  assert.ok(
    repoRelay.calls.some((call) => call.before_id !== undefined),
    "expected the composite cursor to be sent",
  );

  const models = buildProjectReadModels({
    projectEvents: projects.events,
    repositoryEvents: repositories.events,
  });
  const containers = models.filter((project) => !project.implicit);
  assert.deepEqual(
    new Set(containers.map((project) => project.projectAddress)),
    new Set(fixture.expect.containers.map((entry) => entry.project)),
  );
  assert.deepEqual(
    new Set(
      models
        .filter((project) => project.implicit)
        .map((project) => project.repositories[0].repoAddress),
    ),
    new Set(fixture.expect.implicit_cards),
  );
  for (const expected of fixture.expect.containers) {
    const container = containers.find(
      (project) => project.projectAddress === expected.project,
    );
    assert.deepEqual(
      new Set(container.repositories.map((repo) => repo.repoAddress)),
      new Set(expected.members.map((member) => member.coordinate)),
    );
  }
});

test("mode 1 still terminates and loses nothing on a reordered page", async () => {
  // NIP-01 fixes no delivery order. Scanning the page for its oldest row rather
  // than trusting the last element is why a reordered page neither loses a head
  // nor spins. Honest note: taking the last element is not lossy here, it only
  // re-reads, so this case pins termination and completeness — not the scan.
  const allEvents = fixtureEvents();
  const pageSize = fixture.enumeration.page_size;
  const ordered = makeRelay(allEvents, pageSize);
  const shuffled = {
    fetchPage: async (filter) => (await ordered.fetchPage(filter)).reverse(),
  };
  const result = await enumerateEventsComposite(
    shuffled.fetchPage,
    [30617],
    pageSize,
  );
  assert.equal(result.events.length, 3);
  assert.equal(result.possiblyIncomplete, false);
});

test("a naive `until - 1` cursor loses the tied heads mode 1 recovers", async () => {
  // The counter-example, so the test above is not merely restating whatever
  // the implementation happens to do: stepping past the boundary second
  // without a tiebreak drops every head that shared it.
  const allEvents = fixtureEvents();
  const pageSize = fixture.enumeration.page_size;
  const relay = makeRelay(allEvents, pageSize, { honourBeforeId: false });

  const seen = new Map();
  let until;
  for (;;) {
    const page = await relay.fetchPage({
      kinds: [30617],
      limit: pageSize,
      ...(until === undefined ? {} : { until }),
    });
    for (const event of page) seen.set(event.id, event);
    if (page.length < pageSize) break;
    const oldest = Math.min(...page.map((event) => event.created_at));
    if (oldest <= 0) break;
    until = oldest - 1;
  }
  assert.equal(seen.size, 2, "naive cursor should lose the third tied head");
});

test("mode 1 stops instead of looping when the transport drops before_id", async () => {
  const allEvents = fixtureEvents();
  const relay = makeRelay(allEvents, 2, { honourBeforeId: false });
  const result = await enumerateEventsComposite(relay.fetchPage, [30617], 2);
  assert.equal(result.possiblyIncomplete, true);
  assert.ok(relay.calls.length < 10, "must not spin on a stuck cursor");
});

/** Four heads over three seconds, so a page of three truncates second 99. */
function boundaryFixtureEvents() {
  return [
    { created_at: 100, id: "aa" },
    { created_at: 100, id: "ab" },
    { created_at: 99, id: "bb" },
    { created_at: 99, id: "cc" },
  ].map((row) => ({
    id: row.id,
    pubkey: "a".repeat(64),
    kind: 30617,
    created_at: row.created_at,
    content: "",
    tags: [["d", row.id]],
  }));
}

test("mode 2 recovers a head the page boundary cut off mid-second", async () => {
  // Page one is (100,aa) (100,ab) (99,bb) — two distinct timestamps, so an
  // "all tied" heuristic on the page as a whole would not fire — and second 99
  // still holds cc. Draining 99 before stepping past it retrieves cc; the
  // bucket is smaller than a page, so the collection is complete.
  const relay = makeRelay(boundaryFixtureEvents(), 3, {
    honourBeforeId: false,
  });
  const result = await enumerateEventsUntilOnly(relay.fetchPage, [30617], 3);
  assert.deepEqual(
    new Set(result.events.map((event) => event.id)),
    new Set(["aa", "ab", "bb", "cc"]),
  );
  assert.equal(result.possiblyIncomplete, false);
  assert.ok(
    relay.calls.some(
      (call) => call.since !== undefined && call.since === call.until,
    ),
    "expected a boundary-drain page pinned to one second",
  );
});

test("without the drain, that same head is silently lost", async () => {
  const relay = makeRelay(boundaryFixtureEvents(), 3, {
    honourBeforeId: false,
  });
  const seen = new Map();
  let until;
  for (;;) {
    const page = await relay.fetchPage({
      kinds: [30617],
      limit: 3,
      ...(until === undefined ? {} : { until }),
    });
    for (const event of page) seen.set(event.id, event);
    if (page.length < 3) break;
    const oldest = Math.min(...page.map((event) => event.created_at));
    if (oldest <= 0) break;
    until = oldest - 1;
  }
  assert.deepEqual(new Set(seen.keys()), new Set(["aa", "ab", "bb"]));
});

test("mode 2 marks a boundary second exactly one page wide as doubtful", async () => {
  // The spec's worked example, where the bucket holds `limit` events: a bucket
  // of exactly `limit` is indistinguishable from a larger one, and the spec
  // counts inclusively so the doubt is reported rather than guessed away.
  const events = [
    { created_at: 100, id: "aa" },
    { created_at: 99, id: "bb" },
    { created_at: 99, id: "cc" },
    { created_at: 99, id: "dd" },
    { created_at: 98, id: "ee" },
  ].map((row) => ({
    id: row.id,
    pubkey: "a".repeat(64),
    kind: 30617,
    created_at: row.created_at,
    content: "",
    tags: [["d", row.id]],
  }));
  const relay = makeRelay(events, 3, { honourBeforeId: false });
  const result = await enumerateEventsUntilOnly(relay.fetchPage, [30617], 3);
  assert.equal(result.possiblyIncomplete, true);
  // Marked, but not stalled: enumeration still walked past the second.
  assert.deepEqual(
    new Set(result.events.map((event) => event.id)),
    new Set(["aa", "bb", "cc", "dd", "ee"]),
  );
});

test("mode 2 marks the collection incomplete rather than throwing on an unpageable second", async () => {
  const owner = "a".repeat(64);
  const events = Array.from({ length: 4 }, (_, index) => ({
    id: `id-${index}`,
    pubkey: owner,
    kind: 30617,
    created_at: 1_000,
    content: "",
    tags: [["d", `r${index}`]],
  }));
  const relay = makeRelay(events, 2, { honourBeforeId: false });
  const result = await enumerateEventsUntilOnly(relay.fetchPage, [30617], 2);
  // Spec step 3: mark, do not stall, and never present it as complete.
  assert.equal(result.possiblyIncomplete, true);
  assert.ok(result.events.length >= 2);
});

test("both modes reject a non-positive page size", async () => {
  await assert.rejects(
    () => enumerateEventsComposite(async () => [], [30617], 0),
    /positive integer/,
  );
  await assert.rejects(
    () => enumerateEventsUntilOnly(async () => [], [30617], -1),
    /positive integer/,
  );
});

test("an aborted signal stops both modes", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() =>
    enumerateEventsComposite(
      async () => [],
      [30617],
      10,
      undefined,
      controller.signal,
    ),
  );
  await assert.rejects(() =>
    enumerateEventsUntilOnly(
      async () => [],
      [30617],
      10,
      undefined,
      controller.signal,
    ),
  );
});
