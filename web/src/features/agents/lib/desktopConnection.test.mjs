import assert from "node:assert/strict";
import { test } from "node:test";
import { desktopConnection, ownsSettingsAgents } from "./desktopConnection.ts";

const now = 1_800_000_000;
const catalog = (age) => ({
  machine: "crichton.local",
  updatedAt: now - age,
  agents: [],
  harnesses: [],
  version: 4,
});

test("never reports online from catalog age alone", () => {
  for (const age of [0, 5, 60, 3600, 86400, -50]) {
    const text = desktopConnection(catalog(age), now);
    assert.ok(text.startsWith("Buzz Desktop · crichton · last reported "));
    assert.doesNotMatch(text, /online|offline|connected/i);
  }
});
test("desktop footer formats seconds, minutes, hours and days", () => {
  assert.equal(
    desktopConnection(catalog(5), now),
    "Buzz Desktop · crichton · last reported just now",
  );
  assert.equal(
    desktopConnection(catalog(120), now),
    "Buzz Desktop · crichton · last reported 2m ago",
  );
  assert.equal(
    desktopConnection(catalog(7200), now),
    "Buzz Desktop · crichton · last reported 2h ago",
  );
  assert.equal(
    desktopConnection(catalog(172800), now),
    "Buzz Desktop · crichton · last reported 2d ago",
  );
});
test("owner landing accepts a fresh self catalog or any self-owned agent registry entry", () => {
  assert.equal(ownsSettingsAgents([], [], now), false);
  assert.equal(ownsSettingsAgents([catalog(0)], [], now), true);
  assert.equal(ownsSettingsAgents([catalog(21900)], [], now), true);
  assert.equal(ownsSettingsAgents([catalog(21901)], [], now), false);
  assert.equal(ownsSettingsAgents([catalog(-301)], [], now), false);
  assert.equal(ownsSettingsAgents([], [{ pubkey: "a".repeat(64) }], now), true);
});
