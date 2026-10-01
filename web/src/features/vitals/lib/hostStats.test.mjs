import assert from "node:assert/strict";
import { test } from "node:test";

import {
  barTone,
  blockVitalRows,
  crichtonStatus,
  diskLine,
  formatPercent,
  memoryLine,
  primaryDisk,
  servicesLine,
  sparkline,
  stripGpuPercent,
  uptimeLine,
  vitalRows,
} from "./hostStats.ts";

/**
 * W-3 (mapping half): hatch's host stats → the Vitals rows. The sample is
 * the shape hatch served live on 2026-09-30 (docs/DEPLOY-DEV.md in hatch);
 * expected values are written out.
 */

const NOW = Date.parse("2026-09-30T18:00:30.000Z");

function stats(overrides = {}) {
  return {
    host: "crichton",
    sampledAt: "2026-09-30T18:00:25.000Z",
    uptimeSec: 12 * 86_400 + 4 * 3_600 + 59,
    load: [5.24, 3.9, 3.36],
    cpu: 67.2,
    gpu: { percent: 87, renderer: 80, tiler: 12 },
    mem: {
      usedBytes: 55.2 * 1024 ** 3,
      totalBytes: 64 * 1024 ** 3,
      percent: 86.2,
      pressure: "normal",
    },
    disks: [
      {
        name: "crichton-backups",
        mount: "/Volumes/crichton-backups",
        kind: "external",
        totalBytes: 4e12,
        usedBytes: 2.508e12,
        freeBytes: 1.492e12,
        percent: 62.7,
      },
      {
        name: "Data",
        mount: "/System/Volumes/Data",
        kind: "internal",
        totalBytes: 2e12,
        usedBytes: 0.89e12,
        freeBytes: 1.11e12,
        percent: 44.5,
      },
    ],
    primaryDisk: "/System/Volumes/Data",
    services: null,
    ...overrides,
  };
}

test("the four sidebar rows: CPU, GPU, Mem and the PRIMARY disk", () => {
  assert.deepEqual(
    vitalRows(stats()).map((r) => [r.label, r.text, r.tone]),
    [
      ["CPU", "67%", "ink"],
      ["GPU", "87%", "work"],
      ["Mem", "86%", "work"],
      ["Disk", "45%", "ink"],
    ],
  );
});

test("unknown renders as an em dash, never 0%", () => {
  const rows = vitalRows(
    stats({
      cpu: null,
      gpu: { percent: null, renderer: null, tiler: null },
      mem: null,
      disks: [],
    }),
  );
  assert.deepEqual(
    rows.map((r) => r.text),
    ["—", "—", "—", "—"],
  );
  assert.deepEqual(
    rows.map((r) => r.percent),
    [null, null, null, null],
  );
  assert.equal(formatPercent(0), "0%", "a real zero is still a zero");
});

test("the block draws only rows with a reading — and no section without one", () => {
  // Sam, 2026-10-01: hide any row that has no data, never an empty section.
  assert.deepEqual(
    blockVitalRows({ status: "ok", stats: stats() }).map((r) => r.label),
    ["CPU", "GPU", "Mem", "Disk"],
  );
  assert.deepEqual(
    blockVitalRows({
      status: "ok",
      stats: stats({ gpu: { percent: null, renderer: null, tiler: null } }),
    }).map((r) => [r.label, r.text]),
    [
      ["CPU", "67%"],
      ["Mem", "86%"],
      ["Disk", "45%"],
    ],
    "an unknown GPU is left out, not drawn as a dash",
  );
  assert.equal(
    blockVitalRows({
      status: "ok",
      stats: stats({
        cpu: null,
        gpu: { percent: null, renderer: null, tiler: null },
        mem: null,
        disks: [],
      }),
    }),
    null,
    "every value unknown: no crichton section at all",
  );
  // A real zero is a reading, not an absence.
  assert.deepEqual(
    blockVitalRows({ status: "ok", stats: stats({ cpu: 0 }) })[0].text,
    "0%",
  );
  for (const status of ["idle", "offline", "signed-out", "forbidden"]) {
    assert.equal(
      blockVitalRows({ status, stats: null }),
      null,
      `${status}: no header standing over nothing`,
    );
  }
});

test("the phone strip's GPU column exists only with a GPU reading", () => {
  assert.equal(stripGpuPercent({ status: "ok", stats: stats() }), 87);
  assert.equal(
    stripGpuPercent({
      status: "ok",
      stats: stats({ gpu: { percent: null, renderer: null, tiler: null } }),
    }),
    null,
  );
  for (const status of ["idle", "offline", "signed-out", "forbidden"]) {
    assert.equal(stripGpuPercent({ status, stats: null }), null, status);
  }
});

test("tones: ink under 70, honey from 70, coral from 90", () => {
  assert.deepEqual([null, 0, 69.9, 70, 89.9, 90, 100].map(barTone), [
    "ink",
    "ink",
    "ink",
    "work",
    "work",
    "need",
    "need",
  ]);
});

test("primary disk falls back to the first internal one", () => {
  assert.equal(primaryDisk(stats()).name, "Data");
  assert.equal(primaryDisk(stats({ primaryDisk: "/nope" })).name, "Data");
  assert.equal(primaryDisk(stats({ disks: [] })), null);
});

test("status: ok while fresh, stale past 30 s, and the poll's failures by name", () => {
  assert.equal(crichtonStatus({ status: "ok", stats: stats() }, NOW), "ok");
  assert.equal(
    crichtonStatus({ status: "ok", stats: stats() }, NOW + 26_000),
    "stale",
  );
  assert.equal(
    crichtonStatus({ status: "ok", stats: stats() }, NOW + 25_000),
    "ok",
    "exactly 30 s is still fresh",
  );
  assert.equal(
    crichtonStatus({ status: "offline", stats: null }, NOW),
    "offline",
  );
  assert.equal(
    crichtonStatus({ status: "signed-out", stats: null }, NOW),
    "signed-out",
  );
  assert.equal(crichtonStatus({ status: "idle", stats: null }, NOW), null);
});

test("the popover's words", () => {
  assert.equal(uptimeLine(12 * 86_400 + 4 * 3_600 + 59), "up 12d 4h");
  assert.equal(uptimeLine(4 * 3_600 + 12 * 60), "up 4h 12m");
  assert.equal(uptimeLine(null), null);
  assert.equal(memoryLine(stats()), "55.2 / 64 GB · pressure normal");
  assert.equal(diskLine(stats().disks[1]), "Data · 1.1 TB free");
  assert.equal(
    diskLine({ ...stats().disks[1], freeBytes: 740e9 }),
    "Data · 740 GB free",
  );
});

test("services: all up names the latest restart; anything down is named", () => {
  const services = {
    up: 6,
    total: 6,
    items: [
      { name: "relay", up: true, startedAt: "2026-09-21T00:00:00.000Z" },
      { name: "tts bridge", up: true, startedAt: "2026-09-30T16:00:30.000Z" },
    ],
  };
  assert.deepEqual(servicesLine(stats({ services }), NOW), {
    text: "6 Buzz services up · tts bridge restarted 2h ago",
    healthy: true,
  });
  assert.deepEqual(
    servicesLine(
      stats({
        services: {
          up: 5,
          total: 6,
          items: [{ name: "stt bridge", up: false, startedAt: null }],
        },
      }),
      NOW,
    ),
    { text: "5 of 6 Buzz services up · stt bridge down", healthy: false },
  );
});

test("sparklines need two known points and skip unknown ones", () => {
  assert.equal(sparkline([null, 50]), null);
  assert.equal(sparkline([0, 100]), "0,14 140,2");
  assert.equal(sparkline([0, null, 100]), "0,14 140,2");
});
