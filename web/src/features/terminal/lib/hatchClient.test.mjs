import assert from "node:assert/strict";
import { test } from "node:test";

import {
  hatchGet,
  parseHerdr,
  parseHostStats,
  parseMe,
} from "./hatchClient.ts";
import { herdrView } from "./herdrView.ts";

/**
 * hatch's DTOs (hatch app/web/router.ts, routes/herdr.ts, host/collector.ts)
 * parsed defensively: unknown stays null, never 0.
 */

const response = (status, body) => async () =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

test("status mapping: 401 signed-out, 403 forbidden (with hatch's reason), 5xx/network unreachable", async () => {
  assert.deepEqual(
    await hatchGet(
      "https://h.test/",
      "api/me",
      parseMe,
      response(401, { error: "unauthenticated" }),
    ),
    {
      kind: "signed-out",
    },
  );
  assert.deepEqual(
    await hatchGet(
      "https://h.test/",
      "api/me",
      parseMe,
      response(403, { error: "tailnet_user_not_allowed" }),
    ),
    { kind: "forbidden", reason: "tailnet_user_not_allowed" },
  );
  assert.deepEqual(
    await hatchGet("https://h.test/", "api/me", parseMe, response(502, {})),
    {
      kind: "unreachable",
    },
  );
  assert.deepEqual(
    await hatchGet("https://h.test/", "api/me", parseMe, async () => {
      throw new TypeError("Failed to fetch");
    }),
    { kind: "unreachable" },
  );
});

test("every call carries the session cookie and skips the HTTP cache", async () => {
  let seen;
  await hatchGet(
    "https://h.test:6881/",
    "api/host-stats",
    parseHostStats,
    async (url, init) => {
      seen = { url, init };
      return new Response("{}", { status: 200 });
    },
  );
  assert.equal(seen.url, "https://h.test:6881/api/host-stats");
  assert.equal(seen.init.credentials, "include");
  assert.equal(seen.init.cache, "no-store");
});

test("/api/me: the kill switch and its reason", () => {
  assert.deepEqual(
    parseMe({
      email: "sam@example.test",
      terminal: { enabled: false, reason: "runtime_file" },
      session: { name: "default", shared: true },
    }),
    {
      email: "sam@example.test",
      terminal: { enabled: false, reason: "runtime_file" },
      session: { name: "default", shared: true },
    },
  );
  assert.equal(
    parseMe({ email: "x" }),
    null,
    "no terminal block: not hatch's shape",
  );
});

test("/api/host-stats: nulls stay null, a missing mem is null, bad disks are dropped", () => {
  const stats = parseHostStats({
    v: 1,
    host: "crichton",
    sampledAt: "2026-09-30T18:00:00.000Z",
    uptimeSec: 3600,
    load: [1, 2, 3],
    cpu: { percent: null },
    gpu: { percent: 71.4, renderer: null, tiler: 3, top: null },
    disks: [
      {
        name: "Data",
        mount: "/System/Volumes/Data",
        kind: "internal",
        totalBytes: 10,
        usedBytes: 4,
        freeBytes: 6,
        percent: 40,
      },
      { name: "broken", mount: "/Volumes/x", kind: "external", totalBytes: 10 },
    ],
    primaryDisk: "/System/Volumes/Data",
    services: null,
  });
  assert.equal(stats.cpu, null);
  assert.equal(stats.gpu.percent, 71.4);
  assert.equal(stats.gpu.renderer, null);
  assert.equal(stats.mem, null);
  assert.equal(stats.disks.length, 1);
  assert.equal(stats.services, null);
  assert.equal(parseHostStats({ v: 2 }), null);
  assert.equal(parseHostStats({ v: 1, sampledAt: "not a date" }), null);
});

/** hatch's projection of its captured `herdr api snapshot` fixture, plus agents. */
const SNAPSHOT = {
  v: 1,
  running: true,
  session: "default",
  protocol: 16,
  workspaces: [
    { id: "w2", label: "stash", number: 2, focused: false, status: "blocked" },
    { id: "w1", label: "buzz", number: 1, focused: true, status: "working" },
  ],
  tabs: [
    {
      id: "w1:t2",
      workspaceId: "w1",
      label: "jitter QA",
      number: 2,
      focused: false,
      status: "done",
    },
    {
      id: "w1:t1",
      workspaceId: "w1",
      label: "Vitals redesign",
      number: 1,
      focused: true,
      status: "working",
    },
    {
      id: "w2:t1",
      workspaceId: "w2",
      label: "parity walk",
      number: 1,
      focused: false,
      status: "blocked",
    },
  ],
  agents: [
    {
      id: "a2",
      label: "claude",
      workspaceId: "w1",
      tabId: "w1:t2",
      agent: "claude",
      status: "done",
    },
    {
      id: "a1",
      label: "Vitals redesign",
      workspaceId: "w1",
      tabId: "w1:t1",
      agent: "claude",
      status: "working",
    },
    {
      id: "a3",
      label: "parity walk",
      workspaceId: "w2",
      tabId: "w2:t1",
      agent: "codex",
      status: "blocked",
    },
    { id: "bad", label: "no tab", workspaceId: "w1" },
  ],
};

test("herdr: spaces in herdr's order, agents by space then needs-you first, the focused space's tabs", () => {
  const snapshot = parseHerdr(SNAPSHOT);
  assert.equal(snapshot.agents.length, 3, "an agent without a tab is dropped");
  const view = herdrView(snapshot);
  assert.deepEqual(
    view.spaces.map((s) => [s.label, s.focused, s.tone]),
    [
      ["buzz", true, "work"],
      ["stash", false, "need"],
    ],
  );
  assert.deepEqual(
    view.agents.map((a) => [a.space, a.title, a.meta]),
    [
      ["buzz", "Vitals redesign", "claude · working"],
      // label === agent → the tab's label instead of "claude · claude".
      ["buzz", "jitter QA", "claude · done"],
      ["stash", "parity walk", "codex · waiting on you"],
    ],
  );
  assert.deepEqual(
    view.tabs.map((t) => [t.label, t.focused]),
    [
      ["Vitals redesign", true],
      ["jitter QA", false],
    ],
  );
  assert.equal(view.focusedSpace, "buzz");
  assert.equal(view.tabCount, 3);
});

test("herdr stopped and an unknown protocol keep their meaning", () => {
  assert.deepEqual(parseHerdr({ v: 1, running: false, session: "default" }), {
    running: false,
    session: "default",
    unsupported: false,
    workspaces: [],
    tabs: [],
    agents: [],
  });
  assert.equal(
    parseHerdr({ v: 1, running: true, session: "default", unsupported: true })
      .unsupported,
    true,
  );
  assert.equal(parseHerdr({ running: true }), null);
});
