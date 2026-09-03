import assert from "node:assert/strict";
import { test } from "node:test";
import {
  desktopCatalogFromEvent,
  mergeDesktopCatalog,
} from "./desktopCatalog.ts";

const OWNER = "cc".repeat(32);
const AGENT_A = "aa".repeat(32);
const AGENT_B = "bb".repeat(32);

function catalogEvent(overrides = {}) {
  return {
    id: "x".repeat(64),
    pubkey: OWNER,
    kind: 30180,
    created_at: 1788300000,
    tags: [["d", "crichton.local"]],
    content: JSON.stringify({
      format: "buzz-desktop-catalog",
      version: 1,
      machine: "crichton.local",
      harnesses: [
        {
          id: "claude-code-glm",
          label: "Claude Code GLM",
          source: "custom",
          availability: "available",
        },
        {
          id: "claude",
          label: "Claude Code",
          source: "preset",
          availability: "not-installed",
        },
      ],
      agents: [AGENT_A, AGENT_B],
      updated_at: 1788300000,
    }),
    sig: "s".repeat(128),
    ...overrides,
  };
}

function content(overrides = {}) {
  return (
    JSON.parse(catalogEvent().content) && {
      ...JSON.parse(catalogEvent().content),
      ...overrides,
    }
  );
}

test("desktopCatalogFromEvent parses a valid catalog", () => {
  const catalog = desktopCatalogFromEvent(catalogEvent());
  assert.equal(catalog.machine, "crichton.local");
  assert.equal(catalog.version, 1);
  assert.equal(catalog.harnesses.length, 2);
  assert.deepEqual(catalog.harnesses[0], {
    id: "claude-code-glm",
    label: "Claude Code GLM",
    source: "custom",
    availability: "available",
  });
  assert.deepEqual(catalog.agents, [AGENT_A, AGENT_B]);
  assert.equal(catalog.updatedAt, 1788300000);
});

test("desktopCatalogFromEvent accepts version 2 and carries it (the skew guard)", () => {
  // A v2 desktop (Phase-2 capabilities) must still populate an older web's
  // roster — the version gate is >= 1, and capability gating on >= 2 happens
  // elsewhere. This is the row that keeps a desktop bump from blanking the
  // agents screen.
  const catalog = desktopCatalogFromEvent(
    catalogEvent({ content: JSON.stringify(content({ version: 2 })) }),
  );
  assert.notEqual(catalog, null);
  assert.equal(catalog.version, 2);
  assert.equal(catalog.machine, "crichton.local");
  assert.deepEqual(catalog.agents, [AGENT_A, AGENT_B]);
  // A future bump is equally fine to parse.
  const v3 = desktopCatalogFromEvent(
    catalogEvent({ content: JSON.stringify(content({ version: 3 })) }),
  );
  assert.equal(v3.version, 3);
});

test("desktopCatalogFromEvent rejects wrong kind, format, and bad versions", () => {
  assert.equal(desktopCatalogFromEvent(catalogEvent({ kind: 30177 })), null);
  assert.equal(
    desktopCatalogFromEvent(
      catalogEvent({ content: JSON.stringify(content({ format: "other" })) }),
    ),
    null,
  );
  assert.equal(
    desktopCatalogFromEvent(
      catalogEvent({ content: JSON.stringify(content({ version: 0 })) }),
    ),
    null,
  );
  assert.equal(
    desktopCatalogFromEvent(
      catalogEvent({ content: JSON.stringify(content({ version: "2" })) }),
    ),
    null,
  );
  assert.equal(
    desktopCatalogFromEvent(
      catalogEvent({
        content: JSON.stringify(content({ version: Number.NaN })),
      }),
    ),
    null,
  );
  assert.equal(desktopCatalogFromEvent(catalogEvent({ content: "{" })), null);
});

test("desktopCatalogFromEvent rejects a bad machine id", () => {
  // Empty machine…
  assert.equal(
    desktopCatalogFromEvent(
      catalogEvent({ content: JSON.stringify(content({ machine: "" })) }),
    ),
    null,
  );
  // …and a machine that disagrees with its own d tag.
  assert.equal(
    desktopCatalogFromEvent(
      catalogEvent({
        content: JSON.stringify(content({ machine: "aeryn.local" })),
      }),
    ),
    null,
  );
  // Missing d tag entirely.
  assert.equal(desktopCatalogFromEvent(catalogEvent({ tags: [] })), null);
});

test("desktopCatalogFromEvent validates harness entries and agents narrowly", () => {
  const catalog = desktopCatalogFromEvent(
    catalogEvent({
      content: JSON.stringify(
        content({
          harnesses: [
            {
              id: "ok",
              label: "Ok",
              source: "preset",
              availability: "available",
            },
            {
              id: "bad-source",
              label: "Bad",
              source: "mystery",
              availability: "available",
            },
            {
              id: "bad-availability",
              label: "Bad",
              source: "preset",
              availability: "fine",
            },
            "not-an-object",
          ],
          agents: [AGENT_A, "nothex", 42, AGENT_A.toUpperCase()],
        }),
      ),
    }),
  );
  assert.equal(catalog.harnesses.length, 1);
  assert.equal(catalog.harnesses[0].id, "ok");
  // Non-hex dropped; uppercase hex is normalized + deduped.
  assert.deepEqual(catalog.agents, [AGENT_A]);
});

test("mergeDesktopCatalog is newest-wins per machine and immutable", () => {
  const first = desktopCatalogFromEvent(catalogEvent());
  const newer = desktopCatalogFromEvent(
    catalogEvent({
      created_at: 1788400000,
      content: JSON.stringify(
        content({ updated_at: 1788400000, agents: [AGENT_B] }),
      ),
    }),
  );
  const older = desktopCatalogFromEvent(
    catalogEvent({
      created_at: 1788100000,
      content: JSON.stringify(content({ updated_at: 1788100000 })),
    }),
  );
  let catalogs = mergeDesktopCatalog(new Map(), first);
  catalogs = mergeDesktopCatalog(catalogs, newer);
  catalogs = mergeDesktopCatalog(catalogs, older);
  assert.equal(catalogs.size, 1);
  assert.equal(catalogs.get("crichton.local").updatedAt, 1788400000);
  assert.deepEqual(catalogs.get("crichton.local").agents, [AGENT_B]);
  // A tie keeps the incumbent.
  const tied = desktopCatalogFromEvent(
    catalogEvent({
      created_at: 1788400000,
      content: JSON.stringify(content({ updated_at: 1788400000 })),
    }),
  );
  catalogs = mergeDesktopCatalog(catalogs, tied);
  assert.deepEqual(catalogs.get("crichton.local").agents, [AGENT_B]);
});

test("mergeDesktopCatalog keys machines separately", () => {
  const crichton = desktopCatalogFromEvent(catalogEvent());
  const aeryn = desktopCatalogFromEvent(
    catalogEvent({
      tags: [["d", "aeryn.local"]],
      content: JSON.stringify(
        content({ machine: "aeryn.local", agents: [AGENT_A] }),
      ),
    }),
  );
  let catalogs = mergeDesktopCatalog(new Map(), crichton);
  catalogs = mergeDesktopCatalog(catalogs, aeryn);
  assert.equal(catalogs.size, 2);
  assert.deepEqual(catalogs.get("aeryn.local").agents, [AGENT_A]);
});
