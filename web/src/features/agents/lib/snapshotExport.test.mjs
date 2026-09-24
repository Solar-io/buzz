import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { encodeSnapshotPng } from "./pngText.ts";
import {
  BLANK_QUAD_NOTE,
  buildDefinitionSnapshot,
  encodeSnapshotJson,
  memoryEntriesFromListing,
  snapshotFilename,
  validateEncodeSize,
} from "./snapshotExport.ts";
import { decodeSnapshotBytes } from "./snapshotManifest.ts";

const FIXTURE = new URL(
  "../../../../../test-fixtures/agent-snapshots/web-definition.agent.json",
  import.meta.url,
);
const PK = "b".repeat(64);

function persona(content) {
  return {
    id: "0f8fad5b-d9cb-469f-a165-70867728950e",
    name: "x",
    systemPrompt: "",
    model: "",
    provider: "",
    runtime: "",
    updatedAt: 1,
    event: { content: JSON.stringify(content), tags: [], created_at: 1 },
  };
}

const FULL = {
  display_name: "Web Fixture",
  system_prompt: "Review code.\nBe terse.",
  avatar_url: "https://relay.example/media/abc.png",
  runtime: "goose",
  model: "glm-5",
  provider: "openrouter",
  name_pool: ["Ada", "Bo"],
  respond_to: "allowlist",
  respond_to_allowlist: [PK],
  parallelism: 3,
  x_future: 1,
};

test("fixture persona encodes byte-exact to the checked-in fixture", () => {
  const built = buildDefinitionSnapshot(persona(FULL), {
    level: "core",
    entries: [{ slug: "core", body: "I am core." }],
  });
  assert.deepEqual(built.notes, []);
  const bytes = encodeSnapshotJson(built.snapshot);
  assert.equal(
    Buffer.from(bytes).toString("utf8"),
    readFileSync(FIXTURE, "utf8"),
  );
});

test("round-trip: JSON and PNG exports decode through decodeSnapshotBytes", () => {
  const built = buildDefinitionSnapshot(persona(FULL), {
    level: "none",
    entries: [],
  });
  const json = encodeSnapshotJson(built.snapshot);
  for (const bytes of [json, encodeSnapshotPng(json, null)]) {
    const decoded = decodeSnapshotBytes(bytes);
    assert.equal(decoded.kind, "agent");
    assert.equal(decoded.snapshot.displayName, "Web Fixture");
    assert.equal(
      decoded.snapshot.definition.systemPrompt,
      "Review code.\nBe terse.",
    );
    assert.equal(decoded.snapshot.definition.model, "glm-5");
    assert.equal(decoded.snapshot.definition.parallelism, 3);
  }
});

test("parallelism defaults to 10, empty prompt omitted, blank quad noted", () => {
  const built = buildDefinitionSnapshot(
    persona({ display_name: "Min", system_prompt: "" }),
    { level: "none", entries: [] },
  );
  assert.equal(
    Buffer.from(encodeSnapshotJson(built.snapshot)).toString("utf8"),
    '{\n  "format": "buzz-agent-snapshot",\n  "version": 1,\n  "definition": {\n    "name": "Min",\n    "sourceIsBuiltin": false,\n    "parallelism": 10\n  },\n  "profile": {\n    "displayName": "Min"\n  },\n  "memory": {\n    "level": "none"\n  }\n}',
  );
  assert.deepEqual(built.notes, [BLANK_QUAD_NOTE]);
});

test("a data-URL avatar is inlined with the sniffed mime", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]).toString("base64");
  const built = buildDefinitionSnapshot(
    persona({
      display_name: "A",
      avatar_url: `data:image/png;base64,${jpeg}`,
    }),
    { level: "none", entries: [] },
  );
  assert.deepEqual(built.snapshot.profile, {
    displayName: "A",
    avatarDataUrl: `data:image/jpeg;base64,${jpeg}`,
  });
});

test("an https avatar is kept as a ref", () => {
  const built = buildDefinitionSnapshot(
    persona({ display_name: "A", avatar_url: "https://x/a.webp" }),
    { level: "none", entries: [] },
  );
  assert.deepEqual(built.snapshot.profile, {
    displayName: "A",
    avatarUrl: "https://x/a.webp",
  });
});

test("unsafe prompt and blank name refuse", () => {
  assert.equal(
    buildDefinitionSnapshot(
      persona({ display_name: "A", system_prompt: "a​b" }),
      { level: "none", entries: [] },
    ).error,
    "Agent instructions contains prohibited invisible or formatting character U+200B",
  );
  assert.equal(
    buildDefinitionSnapshot(persona({ display_name: " " }), {
      level: "none",
      entries: [],
    }).error,
    "Snapshot definition.name is empty",
  );
});

function listing(overrides = {}) {
  return {
    core: { slug: "core", body: "C" },
    memories: [
      { slug: "mem/a", body: "A" },
      { slug: "mem/b", body: "B" },
    ],
    truncated: false,
    fetchedAt: 1,
    undecryptable: 0,
    ...overrides,
  };
}

test("memory: core-only vs everything selection", () => {
  assert.deepEqual(memoryEntriesFromListing(listing(), "core"), [
    { slug: "core", body: "C" },
  ]);
  assert.deepEqual(memoryEntriesFromListing(listing(), "everything"), [
    { slug: "core", body: "C" },
    { slug: "mem/a", body: "A" },
    { slug: "mem/b", body: "B" },
  ]);
  assert.deepEqual(
    memoryEntriesFromListing(listing({ core: null }), "core"),
    [],
  );
  assert.deepEqual(memoryEntriesFromListing(listing(), "none"), []);
});

test("memory: truncated and undecryptable listings refuse", () => {
  assert.deepEqual(
    memoryEntriesFromListing(listing({ truncated: true }), "core"),
    { error: "Memory may be incomplete — export in the desktop app." },
  );
  assert.deepEqual(
    memoryEntriesFromListing(listing({ undecryptable: 2 }), "everything"),
    { error: "2 memory entries could not be decrypted." },
  );
});

test("encode size caps use the Rust wording", () => {
  assert.equal(validateEncodeSize(5 * 1024 * 1024, false), null);
  assert.equal(
    validateEncodeSize(5 * 1024 * 1024 + 1, false),
    "Snapshot exceeds the 5 MiB size limit for .agent.json files. Reduce memory size or use a config-only snapshot.",
  );
  assert.equal(
    validateEncodeSize(10 * 1024 * 1024 + 1, true),
    "Snapshot exceeds the 10 MiB size limit for .agent.png files. Reduce the avatar image size or use JSON format.",
  );
});

test("snapshotFilename mirrors util::slugify(name, agent, 50)", () => {
  assert.equal(snapshotFilename("My Agent!", false), "my-agent.agent.json");
  assert.equal(snapshotFilename("  ", true), "agent.agent.png");
  assert.equal(snapshotFilename("é😀x", false), "x.agent.json");
  // One hyphen per code point (Rust chars()), not per UTF-16 unit.
  assert.equal(snapshotFilename("a😀b", false), "a-b.agent.json");
  assert.equal(snapshotFilename("a😀😀b", false), "a--b.agent.json");
  assert.equal(
    snapshotFilename(`${"a".repeat(49)} b`, false),
    `${"a".repeat(49)}.agent.json`,
  );
});
