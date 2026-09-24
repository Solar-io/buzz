import assert from "node:assert/strict";
import { test } from "node:test";
import { PLACEHOLDER_PNG } from "./pngText.ts";
import { readSnapshotFile } from "./snapshotFile.ts";

const json = new TextEncoder().encode("{}");

test("ok: matching name and magic pass the bytes through", () => {
  assert.deepEqual(readSnapshotFile("a.agent.json", json), { bytes: json });
  assert.deepEqual(readSnapshotFile("A.AGENT.PNG", PLACEHOLDER_PNG), {
    bytes: PLACEHOLDER_PNG,
  });
});

test("name/magic mismatch refuses with the fetch-path wording", () => {
  assert.deepEqual(readSnapshotFile("a.agent.json", PLACEHOLDER_PNG), {
    error: "format mismatch: filename is .agent.json but bytes are a PNG",
  });
  assert.deepEqual(readSnapshotFile("a.agent.png", json), {
    error: "format mismatch: filename is .agent.png but bytes are not a PNG",
  });
});

test("unknown extension refuses", () => {
  assert.deepEqual(readSnapshotFile("a.json", json), {
    error:
      '"a.json" is not a snapshot filename — expected .agent.json, .agent.png, .team.json, or .team.png',
  });
});

test("over-cap refuses before any decode", () => {
  const big = new Uint8Array(6 * 1024 * 1024);
  assert.deepEqual(readSnapshotFile("a.agent.json", big), {
    error:
      "Snapshot file is too large (6 MiB). .agent.json snapshots must be under 5 MiB.",
  });
  const atCap = new Uint8Array(5 * 1024 * 1024);
  assert.ok("bytes" in readSnapshotFile("a.agent.json", atCap));
});
