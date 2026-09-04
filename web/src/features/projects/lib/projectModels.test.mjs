/**
 * NIP-MP conformance.
 *
 * The oracles are the repository's own fixture files — the same ones the Rust
 * relay validator and the Rust event builder are tested against — so these
 * assertions describe the protocol, not this parser's output:
 *
 *   docs/nips/NIP-MP.fixtures.json      → the ingest envelope (accept/reject
 *                                          plus the rule id that must fire)
 *   docs/nips/NIP-MP.fold-fixtures.json → the client-side fold (which project
 *                                          renders, which members sit inside
 *                                          it, which repositories keep a card)
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  buildProjectReadModels,
  deduplicateAddressableEvents,
  eventToRepository,
  ProjectEnvelopeError,
  parseRepositoryAddress,
  selectProjectRepository,
  validateProjectEventEnvelope,
} from "./projectModels.ts";

const repoRoot = new URL("../../../../../", import.meta.url);
const envelopeFixtures = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("docs/nips/NIP-MP.fixtures.json", repoRoot)),
    "utf8",
  ),
);
const foldFixtures = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("docs/nips/NIP-MP.fold-fixtures.json", repoRoot)),
    "utf8",
  ),
);

/** Deterministic 64-hex event id from any string, so ties break predictably. */
function fakeId(seed) {
  let hash = 0x811c9dc5;
  const digits = [];
  for (let round = 0; round < 8; round += 1) {
    for (const char of `${seed}:${round}`) {
      hash ^= char.codePointAt(0);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    digits.push(hash.toString(16).padStart(8, "0"));
  }
  return digits.join("").slice(0, 64);
}

function splitCoordinate(coordinate) {
  const first = coordinate.indexOf(":");
  const second = coordinate.indexOf(":", first + 1);
  return {
    kind: Number(coordinate.slice(0, first)),
    pubkey: coordinate.slice(first + 1, second),
    dtag: coordinate.slice(second + 1),
  };
}

// ── Harness sanity ─────────────────────────────────────────────────────────
// A runner that silently matched nothing would report success. Pin the counts.

test("fixture oracles loaded with the expected case counts", () => {
  assert.equal(envelopeFixtures.kind, 30621);
  assert.equal(envelopeFixtures.member_cap, 64);
  assert.equal(envelopeFixtures.cases.length, 31);
  assert.equal(foldFixtures.cases.length, 12);
  assert.equal(
    envelopeFixtures.cases.filter((c) => c.expect === "accept").length,
    11,
  );
  assert.equal(
    envelopeFixtures.cases.filter((c) => c.expect === "reject").length,
    20,
  );
});

// ── Envelope: docs/nips/NIP-MP.fixtures.json ───────────────────────────────

for (const fixture of envelopeFixtures.cases) {
  test(`NIP-MP envelope: ${fixture.name} (${fixture.expect})`, () => {
    const { tags, content } = fixture.template;
    if (fixture.expect === "accept") {
      validateProjectEventEnvelope(tags, content);
      return;
    }
    let thrown;
    try {
      validateProjectEventEnvelope(tags, content);
    } catch (error) {
      thrown = error;
    }
    assert.ok(
      thrown instanceof ProjectEnvelopeError,
      `expected a ProjectEnvelopeError for ${fixture.name}, got ${thrown}`,
    );
    // The rule id must match: an implementation that rejected for an unrelated
    // reason would otherwise pass every reject fixture by accident.
    assert.ok(
      fixture.reject_rules.includes(thrown.rule),
      `${fixture.name} rejected with rule "${thrown.rule}", expected one of ${fixture.reject_rules.join(", ")}`,
    );
  });
}

// ── Fold: docs/nips/NIP-MP.fold-fixtures.json ──────────────────────────────

/** Turns one semantic fold case into the signed-shaped events the fold reads. */
function eventsForFoldCase(fixture) {
  const repositoryEvents = [];
  const projectEvents = [];
  const deletionEvents = [];
  const hiddenAddresses = new Set();

  for (const repository of fixture.repositories) {
    const { pubkey, dtag } = splitCoordinate(repository.coordinate);
    const tags = [
      ["d", dtag],
      ["name", dtag],
    ];
    if (repository.maintainers?.length) {
      tags.push(["maintainers", ...repository.maintainers]);
    }
    const createdAt = repository.created_at ?? 1_000;
    repositoryEvents.push({
      id: fakeId(repository.coordinate),
      pubkey,
      kind: 30617,
      created_at: createdAt,
      content: "",
      tags,
    });
    if (repository.state === "deleted") {
      deletionEvents.push({
        id: fakeId(`del:${repository.coordinate}`),
        pubkey,
        kind: 5,
        created_at: createdAt,
        content: "",
        tags: [["a", repository.coordinate]],
      });
    }
    if (repository.viewer_hidden) hiddenAddresses.add(repository.coordinate);
  }

  for (const project of fixture.projects) {
    const { dtag } = splitCoordinate(project.coordinate);
    const tags = [["d", dtag]];
    for (const member of project.members) tags.push(["a", member]);
    if (project.visibility === "unlisted") {
      tags.push(["buzz-visibility", "unlisted"]);
    }
    const createdAt = project.created_at ?? 900;
    projectEvents.push({
      id: fakeId(project.coordinate),
      pubkey: project.signer,
      kind: 30621,
      created_at: createdAt,
      content: "",
      tags,
    });
    if (project.state === "deleted") {
      deletionEvents.push({
        id: fakeId(`del:${project.coordinate}`),
        pubkey: project.signer,
        kind: 5,
        created_at: createdAt,
        content: "",
        tags: [["a", project.coordinate]],
      });
    }
    if (project.viewer_hidden) hiddenAddresses.add(project.coordinate);
  }

  return { repositoryEvents, projectEvents, deletionEvents, hiddenAddresses };
}

for (const fixture of foldFixtures.cases) {
  test(`NIP-MP fold: ${fixture.name}`, () => {
    const input = eventsForFoldCase(fixture);
    const models = buildProjectReadModels(input);

    const containers = models.filter((project) => !project.implicit);
    const implicitCards = models.filter((project) => project.implicit);

    // Every collection in `expect` is compared as a set: the fold fixes
    // placement, not order.
    assert.deepEqual(
      new Set(containers.map((project) => project.projectAddress)),
      new Set(fixture.expect.containers.map((entry) => entry.project)),
    );
    assert.deepEqual(
      new Set(
        implicitCards.map((project) => project.repositories[0].repoAddress),
      ),
      new Set(fixture.expect.implicit_cards),
    );

    for (const expected of fixture.expect.containers) {
      const container = containers.find(
        (project) => project.projectAddress === expected.project,
      );
      assert.ok(container, `missing container ${expected.project}`);
      const resolved = new Set(
        expected.members
          .filter((member) => member.render === "resolved")
          .map((member) => member.coordinate),
      );
      const unavailable = new Set(
        expected.members
          .filter((member) => member.render === "unavailable")
          .map((member) => member.coordinate),
      );
      assert.deepEqual(
        new Set(
          container.repositories.map((repository) => repository.repoAddress),
        ),
        resolved,
        `resolved members of ${expected.project}`,
      );
      assert.deepEqual(
        new Set(container.unavailableRepositoryAddresses),
        unavailable,
        `unavailable members of ${expected.project}`,
      );
    }
  });
}

// ── Parsing details the fixtures do not reach ──────────────────────────────

test("a repository address keeps colons that belong to the d tag", () => {
  const owner = "a".repeat(64);
  assert.deepEqual(parseRepositoryAddress(`30617:${owner}:group:repo`), {
    owner,
    dtag: "group:repo",
  });
});

test("an uppercase owner is not a usable member coordinate", () => {
  // `#a` filter matching is byte-exact, so an uppercase coordinate addresses
  // a repository no subscription could ever resolve.
  assert.equal(parseRepositoryAddress(`30617:${"A".repeat(64)}:buzz`), null);
});

test("NIP-33 head selection is latest-wins with a lowest-id tiebreak", () => {
  const pubkey = "a".repeat(64);
  const base = { pubkey, kind: 30617, content: "", tags: [["d", "buzz"]] };
  const heads = deduplicateAddressableEvents([
    { ...base, id: "b".repeat(64), created_at: 10 },
    { ...base, id: "a".repeat(64), created_at: 10 },
    { ...base, id: "c".repeat(64), created_at: 9 },
  ]);
  assert.equal(heads.length, 1);
  assert.equal(heads[0].id, "a".repeat(64));
});

test("a repository with no clone tag gets the canonical relay-hosted URL", () => {
  const owner = "a".repeat(64);
  const repository = eventToRepository(
    {
      id: fakeId("clone"),
      pubkey: owner,
      kind: 30617,
      created_at: 1,
      content: "",
      tags: [["d", "buzz"]],
    },
    "https://relay.example/",
  );
  assert.deepEqual(repository.cloneUrls, [
    `https://relay.example/git/${owner}/buzz`,
  ]);
});

test("an explicit clone tag is never overridden by the derived URL", () => {
  const repository = eventToRepository(
    {
      id: fakeId("clone2"),
      pubkey: "a".repeat(64),
      kind: 30617,
      created_at: 1,
      content: "",
      tags: [
        ["d", "buzz"],
        ["clone", "https://github.com/block/buzz.git"],
      ],
    },
    "https://relay.example",
  );
  assert.deepEqual(repository.cloneUrls, ["https://github.com/block/buzz.git"]);
});

test("a deletion older than the head does not bury it", () => {
  const owner = "a".repeat(64);
  const models = buildProjectReadModels({
    projectEvents: [],
    repositoryEvents: [
      {
        id: fakeId("republished"),
        pubkey: owner,
        kind: 30617,
        created_at: 200,
        content: "",
        tags: [["d", "buzz"]],
      },
    ],
    deletionEvents: [
      {
        id: fakeId("stale-deletion"),
        pubkey: owner,
        kind: 5,
        created_at: 100,
        content: "",
        tags: [["a", `30617:${owner}:buzz`]],
      },
    ],
  });
  assert.equal(models.length, 1);
});

test("a deletion signed by someone other than the coordinate owner is ignored", () => {
  const owner = "a".repeat(64);
  const stranger = "b".repeat(64);
  const models = buildProjectReadModels({
    projectEvents: [],
    repositoryEvents: [
      {
        id: fakeId("victim"),
        pubkey: owner,
        kind: 30617,
        created_at: 100,
        content: "",
        tags: [["d", "buzz"]],
      },
    ],
    deletionEvents: [
      {
        id: fakeId("forged-deletion"),
        pubkey: stranger,
        kind: 5,
        created_at: 500,
        content: "",
        tags: [["a", `30617:${owner}:buzz`]],
      },
    ],
  });
  assert.equal(models.length, 1);
});

test("projects list newest first", () => {
  const owner = "a".repeat(64);
  const repositoryEvents = [
    {
      id: fakeId("old"),
      pubkey: owner,
      kind: 30617,
      created_at: 100,
      content: "",
      tags: [
        ["d", "old"],
        ["name", "Old"],
      ],
    },
    {
      id: fakeId("new"),
      pubkey: owner,
      kind: 30617,
      created_at: 300,
      content: "",
      tags: [
        ["d", "new"],
        ["name", "New"],
      ],
    },
  ];
  const models = buildProjectReadModels({
    projectEvents: [],
    repositoryEvents,
  });
  assert.deepEqual(
    models.map((project) => project.name),
    ["New", "Old"],
  );
});

test("the detail view opens on the repository sharing the project's slug", () => {
  const owner = "a".repeat(64);
  const models = buildProjectReadModels({
    projectEvents: [
      {
        id: fakeId("proj"),
        pubkey: owner,
        kind: 30621,
        created_at: 300,
        content: "",
        tags: [
          ["d", "platform"],
          ["a", `30617:${owner}:other`],
          ["a", `30617:${owner}:platform`],
        ],
      },
    ],
    repositoryEvents: [
      {
        id: fakeId("r1"),
        pubkey: owner,
        kind: 30617,
        created_at: 100,
        content: "",
        tags: [["d", "other"]],
      },
      {
        id: fakeId("r2"),
        pubkey: owner,
        kind: 30617,
        created_at: 100,
        content: "",
        tags: [["d", "platform"]],
      },
    ],
  });
  const project = models.find((candidate) => !candidate.implicit);
  assert.equal(selectProjectRepository(project).dtag, "platform");
  assert.equal(
    selectProjectRepository(project, `${owner}:other`).dtag,
    "other",
  );
});
