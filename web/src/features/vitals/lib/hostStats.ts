/**
 * crichton's host stats → the Vitals rows (Vitals artboard; phase-7.md §8,
 * W-3). Pure.
 *
 * Unknown stays unknown: a null reading is never "0%", and an unreachable
 * hatch never leaves the last numbers on screen as if they were now. The
 * sidebar block and the phone strip draw only readings that exist — no row
 * without a number and no "crichton" header alone (Sam, 2026-10-01); the
 * popover still renders "—" and says why crichton is quiet.
 */

import type {
  HostDisk,
  HostStats,
} from "@/features/terminal/lib/hatchClient.ts";

/** A sample older than this is shown as stale (the collector ticks every 10 s). */
export const STALE_AFTER_MS = 30_000;

export type BarTone = "ink" | "work" | "need";

/**
 * The bar colour: ink while comfortable, honey from 70 %, coral from 90 %.
 * (The artboard's GPU at 71 % and Backup at 84 % are honey; 38–64 % ink.)
 */
export function barTone(percent: number | null): BarTone {
  if (percent === null) return "ink";
  if (percent >= 90) return "need";
  if (percent >= 70) return "work";
  return "ink";
}

/** Whole percent, or the em dash for unknown. Never coerces null to 0. */
export function formatPercent(percent: number | null): string {
  return percent === null ? "—" : `${Math.round(percent)}%`;
}

/** Clamp for a bar width; null draws no fill at all. */
export function barWidth(percent: number | null): number | null {
  return percent === null ? null : Math.min(100, Math.max(0, percent));
}

export interface VitalRow {
  key: "cpu" | "gpu" | "mem" | "disk";
  label: string;
  percent: number | null;
  text: string;
  tone: BarTone;
}

/** The disk the sidebar's one Disk row shows: hatch's `primaryDisk`, else the first internal one. */
export function primaryDisk(stats: HostStats): HostDisk | null {
  return (
    stats.disks.find((d) => d.mount === stats.primaryDisk) ??
    stats.disks.find((d) => d.kind === "internal") ??
    stats.disks[0] ??
    null
  );
}

function row(
  key: VitalRow["key"],
  label: string,
  percent: number | null,
): VitalRow {
  return {
    key,
    label,
    percent,
    text: formatPercent(percent),
    tone: barTone(percent),
  };
}

/** The four sidebar rows: CPU, GPU, Mem, Disk. */
export function vitalRows(stats: HostStats): VitalRow[] {
  return [
    row("cpu", "CPU", stats.cpu),
    row("gpu", "GPU", stats.gpu.percent),
    row("mem", "Mem", stats.mem?.percent ?? null),
    row("disk", "Disk", primaryDisk(stats)?.percent ?? null),
  ];
}

/** The poll fields the block / strip decisions read. */
interface HostPoll {
  status: "idle" | "ok" | "offline" | "signed-out" | "forbidden";
  stats: HostStats | null;
}

/**
 * The sidebar block's crichton rows: only the ones with a reading, or null
 * when there is none to draw — offline, signed out, not allowed, not polled
 * yet, or a sample with every value unknown. Null means no section at all,
 * never a "crichton" header standing over nothing.
 */
export function blockVitalRows(poll: HostPoll): VitalRow[] | null {
  if (poll.status !== "ok" || !poll.stats) return null;
  const rows = vitalRows(poll.stats).filter((r) => r.percent !== null);
  return rows.length > 0 ? rows : null;
}

/** The phone Work strip's GPU reading, or null when there is none to show. */
export function stripGpuPercent(poll: HostPoll): number | null {
  if (poll.status !== "ok" || !poll.stats) return null;
  return poll.stats.gpu.percent;
}

export type CrichtonStatus =
  | "ok"
  | "stale"
  | "offline"
  | "signed-out"
  | "forbidden";

export function isStale(stats: HostStats, nowMs: number): boolean {
  const at = Date.parse(stats.sampledAt);
  return !Number.isFinite(at) || nowMs - at > STALE_AFTER_MS;
}

/** What the "crichton" header says beside its dot. */
export function crichtonStatus(
  poll: {
    status: "idle" | "ok" | "offline" | "signed-out" | "forbidden";
    stats: HostStats | null;
  },
  nowMs: number,
): CrichtonStatus | null {
  switch (poll.status) {
    case "idle":
      return null;
    case "ok":
      return poll.stats && !isStale(poll.stats, nowMs) ? "ok" : "stale";
    default:
      return poll.status;
  }
}

export const STATUS_TEXT: Record<CrichtonStatus, string> = {
  ok: "ok",
  stale: "stale",
  offline: "offline",
  "signed-out": "sign in",
  forbidden: "not allowed",
};

const GIB = 1024 ** 3;

function gb(bytes: number, unit: number): string {
  const value = bytes / unit;
  if (value >= 1000) return `${(value / 1000).toFixed(1)} TB`;
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} GB`;
}

/** "41.2 / 64 GB · pressure normal" (RAM in GiB, as Activity Monitor counts it). */
export function memoryLine(stats: HostStats): string | null {
  const mem = stats.mem;
  if (!mem) return null;
  const used = mem.usedBytes / GIB;
  const total = mem.totalBytes / GIB;
  const usedText = used < 100 ? used.toFixed(1) : String(Math.round(used));
  const base = `${usedText} / ${Math.round(total)} GB`;
  return mem.pressure ? `${base} · pressure ${mem.pressure}` : base;
}

/** "Data · 740 GB free" (disks in decimal GB, as Finder counts them). */
export function diskLine(disk: HostDisk): string {
  return `${disk.name} · ${gb(disk.freeBytes, 1000 ** 3)} free`;
}

export function loadLine(stats: HostStats): string | null {
  return stats.load
    ? `load ${stats.load.map((n) => n.toFixed(1)).join(" · ")}`
    : null;
}

/** "up 12d 4h" / "up 4h 12m" / "up 12m". */
export function uptimeLine(seconds: number | null): string | null {
  if (seconds === null || seconds < 0) return null;
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `up ${days}d ${hours}h`;
  if (hours > 0) return `up ${hours}h ${minutes}m`;
  return `up ${minutes}m`;
}

function ago(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

/** "6 Buzz services up · tts bridge restarted 2h ago", or what is down. */
export function servicesLine(
  stats: HostStats,
  nowMs: number,
): { text: string; healthy: boolean } | null {
  const services = stats.services;
  if (!services || services.total === 0) return null;
  const down = services.items.filter((s) => !s.up).map((s) => s.name);
  const head =
    services.up === services.total
      ? `${services.total} Buzz services up`
      : `${services.up} of ${services.total} Buzz services up · ${down.join(", ")} down`;
  // The most recent (re)start inside a day is worth a mention.
  const recent = services.items
    .filter((s) => s.up && s.startedAt)
    .map((s) => ({ name: s.name, at: Date.parse(s.startedAt ?? "") }))
    .filter(
      (s) =>
        Number.isFinite(s.at) && nowMs - s.at < 86_400_000 && nowMs >= s.at,
    )
    .sort((a, b) => b.at - a.at)[0];
  return {
    text: recent
      ? `${head} · ${recent.name} restarted ${ago(nowMs - recent.at)}`
      : head,
    healthy: services.up === services.total,
  };
}

/** A 140×16 polyline from recent samples; null below two known points. */
export function sparkline(
  values: ReadonlyArray<number | null>,
  width = 140,
  height = 16,
): string | null {
  const known = values
    .map((v, i) => ({ v, i }))
    .filter((p): p is { v: number; i: number } => p.v !== null);
  if (known.length < 2) return null;
  const span = Math.max(values.length - 1, 1);
  return known
    .map(({ v, i }) => {
      const x = (i / span) * width;
      const y =
        height - 2 - (Math.min(100, Math.max(0, v)) / 100) * (height - 4);
      return `${Math.round(x * 10) / 10},${Math.round(y * 10) / 10}`;
    })
    .join(" ");
}
