import assert from "node:assert/strict";
import test from "node:test";
import { desktopCatalogFromEvent } from "./desktopCatalog.ts";

test("v5 catalog with unknown fields still parses harnesses/agents", () => {
  const parsed = desktopCatalogFromEvent({
    kind: 30180,
    tags: [["d", "crichton.local"]],
    content: JSON.stringify({
      format: "buzz-desktop-catalog",
      version: 5,
      machine: "crichton.local",
      harnesses: [
        { id: "x", label: "X", source: "custom", availability: "available" },
      ],
      agents: ["aa".repeat(32)],
      updated_at: 1,
      caps: ["ping"],
      future_unknown: { anything: 1 },
    }),
  });
  assert.equal(parsed.harnesses.length, 1);
  assert.deepEqual(parsed.agents, ["aa".repeat(32)]);
});
