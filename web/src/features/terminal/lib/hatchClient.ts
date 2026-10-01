/**
 * The hatch HTTP client (phase-7.md §5, §8 `lib/hatchClient.ts`).
 *
 * Every call rides the `hatch_session` cookie (`credentials: "include"`): it
 * is SameSite=Strict, and Buzz (:6351) and hatch (:6881) share a host, so the
 * browser treats them as the same site and sends it. Forgiving like
 * usageHub.ts: a failure is a typed outcome, never a thrown error and never a
 * zero — "unreachable" must not render as "0% CPU".
 */

export type HatchResult<T> =
  | { kind: "ok"; data: T }
  /** 401: no session, or it expired. */
  | { kind: "signed-out" }
  /** 403: signed in, but not on the allowlist (email or tailnet user). */
  | { kind: "forbidden"; reason: string | null }
  /** Network error, timeout, 5xx, or a body that is not the shape we know. */
  | { kind: "unreachable" };

export interface HatchMe {
  email: string | null;
  terminal: { enabled: boolean; reason: string | null };
  session: { name: string; shared: boolean };
}

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface HerdrSnapshot {
  running: boolean;
  session: string;
  /** herdr answered with a protocol this build does not know. */
  unsupported: boolean;
  workspaces: Array<{
    id: string;
    label: string;
    number: number | null;
    focused: boolean;
    status: AgentStatus;
  }>;
  tabs: Array<{
    id: string;
    workspaceId: string;
    label: string;
    number: number | null;
    focused: boolean;
    status: AgentStatus;
  }>;
  agents: Array<{
    id: string;
    label: string;
    workspaceId: string;
    tabId: string;
    agent: string | null;
    status: AgentStatus;
  }>;
}

export interface HostDisk {
  name: string;
  mount: string;
  kind: "internal" | "external";
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  percent: number;
}

export interface HostService {
  name: string;
  up: boolean;
  startedAt: string | null;
}

export interface HostStats {
  host: string;
  sampledAt: string;
  uptimeSec: number | null;
  load: [number, number, number] | null;
  cpu: number | null;
  gpu: {
    percent: number | null;
    renderer: number | null;
    tiler: number | null;
  };
  mem: {
    usedBytes: number;
    totalBytes: number;
    percent: number;
    pressure: "normal" | "warn" | "critical" | null;
  } | null;
  disks: HostDisk[];
  primaryDisk: string | null;
  services: { up: number; total: number; items: HostService[] } | null;
}

const TIMEOUT_MS = 8_000;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
/** A finite number, else null. Never coerces a missing value to 0. */
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const list = (v: unknown): Rec[] => (Array.isArray(v) ? v.filter(isRec) : []);
const STATUSES: readonly AgentStatus[] = [
  "idle",
  "working",
  "blocked",
  "done",
  "unknown",
];
const status = (v: unknown): AgentStatus =>
  STATUSES.includes(v as AgentStatus) ? (v as AgentStatus) : "unknown";

export function parseMe(raw: unknown): HatchMe | null {
  if (!isRec(raw) || !isRec(raw.terminal)) {
    return null;
  }
  const session = isRec(raw.session) ? raw.session : {};
  return {
    email: str(raw.email),
    terminal: {
      enabled: raw.terminal.enabled === true,
      reason: str(raw.terminal.reason),
    },
    session: {
      name: str(session.name) ?? "",
      shared: session.shared === true,
    },
  };
}

export function parseHerdr(raw: unknown): HerdrSnapshot | null {
  if (!isRec(raw) || raw.v !== 1 || typeof raw.running !== "boolean") {
    return null;
  }
  return {
    running: raw.running,
    session: str(raw.session) ?? "",
    unsupported: raw.unsupported === true,
    workspaces: list(raw.workspaces).flatMap((w) => {
      const id = str(w.id);
      return id
        ? [
            {
              id,
              label: str(w.label) ?? id,
              number: num(w.number),
              focused: w.focused === true,
              status: status(w.status),
            },
          ]
        : [];
    }),
    tabs: list(raw.tabs).flatMap((t) => {
      const id = str(t.id);
      const workspaceId = str(t.workspaceId);
      return id && workspaceId
        ? [
            {
              id,
              workspaceId,
              label: str(t.label) ?? id,
              number: num(t.number),
              focused: t.focused === true,
              status: status(t.status),
            },
          ]
        : [];
    }),
    agents: list(raw.agents).flatMap((a) => {
      const id = str(a.id);
      const workspaceId = str(a.workspaceId);
      const tabId = str(a.tabId);
      return id && workspaceId && tabId
        ? [
            {
              id,
              label: str(a.label) ?? id,
              workspaceId,
              tabId,
              agent: str(a.agent),
              status: status(a.status),
            },
          ]
        : [];
    }),
  };
}

function parseDisk(d: Rec): HostDisk | null {
  const name = str(d.name);
  const mount = str(d.mount);
  const total = num(d.totalBytes);
  const used = num(d.usedBytes);
  const free = num(d.freeBytes);
  const percent = num(d.percent);
  if (!name || !mount || total === null || used === null || free === null) {
    return null;
  }
  if (percent === null) {
    return null;
  }
  return {
    name,
    mount,
    kind: d.kind === "external" ? "external" : "internal",
    totalBytes: total,
    usedBytes: used,
    freeBytes: free,
    percent,
  };
}

const PRESSURES = ["normal", "warn", "critical"] as const;

export function parseHostStats(raw: unknown): HostStats | null {
  if (!isRec(raw) || raw.v !== 1) {
    return null;
  }
  const sampledAt = str(raw.sampledAt);
  if (!sampledAt || !Number.isFinite(Date.parse(sampledAt))) {
    return null;
  }
  const cpu = isRec(raw.cpu) ? num(raw.cpu.percent) : null;
  const gpu = isRec(raw.gpu) ? raw.gpu : {};
  const memRaw = isRec(raw.mem) ? raw.mem : null;
  const memUsed = memRaw ? num(memRaw.usedBytes) : null;
  const memTotal = memRaw ? num(memRaw.totalBytes) : null;
  const memPercent = memRaw ? num(memRaw.percent) : null;
  const load = Array.isArray(raw.load) ? raw.load.map(num) : [];
  const servicesRaw = isRec(raw.services) ? raw.services : null;
  const servicesUp = servicesRaw ? num(servicesRaw.up) : null;
  const servicesTotal = servicesRaw ? num(servicesRaw.total) : null;
  return {
    host: str(raw.host) ?? "crichton",
    sampledAt,
    uptimeSec: num(raw.uptimeSec),
    load:
      load.length === 3 && load.every((n) => n !== null)
        ? (load as [number, number, number])
        : null,
    cpu,
    gpu: {
      percent: num(gpu.percent),
      renderer: num(gpu.renderer),
      tiler: num(gpu.tiler),
    },
    mem:
      memUsed !== null && memTotal !== null && memPercent !== null
        ? {
            usedBytes: memUsed,
            totalBytes: memTotal,
            percent: memPercent,
            pressure: PRESSURES.includes(
              memRaw?.pressure as (typeof PRESSURES)[number],
            )
              ? (memRaw?.pressure as (typeof PRESSURES)[number])
              : null,
          }
        : null,
    disks: list(raw.disks).flatMap((d) => {
      const disk = parseDisk(d);
      return disk ? [disk] : [];
    }),
    primaryDisk: str(raw.primaryDisk),
    services:
      servicesRaw && servicesUp !== null && servicesTotal !== null
        ? {
            up: servicesUp,
            total: servicesTotal,
            items: list(servicesRaw.items).flatMap((s) => {
              const name = str(s.name);
              return name
                ? [{ name, up: s.up === true, startedAt: str(s.startedAt) }]
                : [];
            }),
          }
        : null,
  };
}

function timeoutSignal(): AbortSignal | undefined {
  return typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(TIMEOUT_MS)
    : undefined;
}

type Fetch = typeof fetch;

/** GET a hatch path with the session cookie; map the status to a result. */
export async function hatchGet<T>(
  base: string,
  path: string,
  parse: (raw: unknown) => T | null,
  fetchImpl: Fetch = fetch,
): Promise<HatchResult<T>> {
  let response: Response;
  try {
    response = await fetchImpl(new URL(path, base).toString(), {
      credentials: "include",
      cache: "no-store",
      signal: timeoutSignal(),
    });
  } catch {
    return { kind: "unreachable" };
  }
  if (response.status === 401) {
    return { kind: "signed-out" };
  }
  if (response.status === 403) {
    let reason: string | null = null;
    try {
      const body: unknown = await response.json();
      reason = isRec(body) ? str(body.error) : null;
    } catch {
      reason = null;
    }
    return { kind: "forbidden", reason };
  }
  if (!response.ok) {
    return { kind: "unreachable" };
  }
  try {
    const data = parse(await response.json());
    return data ? { kind: "ok", data } : { kind: "unreachable" };
  } catch {
    return { kind: "unreachable" };
  }
}

export const fetchMe = (base: string, fetchImpl?: Fetch) =>
  hatchGet(base, "api/me", parseMe, fetchImpl);
export const fetchHerdr = (base: string, fetchImpl?: Fetch) =>
  hatchGet(base, "api/herdr", parseHerdr, fetchImpl);
export const fetchHostStats = (base: string, fetchImpl?: Fetch) =>
  hatchGet(base, "api/host-stats", parseHostStats, fetchImpl);

/**
 * Upload one pasted file for the terminal (§5.5). Returns the absolute path
 * hatch stored it at. Throws with the server's reason on failure — the paste
 * handler turns that into a status line.
 */
export async function uploadForTerminal(
  base: string,
  file: File,
  name: string,
  fetchImpl: Fetch = fetch,
): Promise<string> {
  const url = new URL("api/term/upload", base);
  url.searchParams.set("name", name || "upload");
  const response = await fetchImpl(url.toString(), {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/octet-stream" },
    body: file,
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const path = isRec(body) ? str(body.path) : null;
  if (!response.ok || !path) {
    const reason = isRec(body) ? str(body.error) : null;
    throw new Error(reason ?? `upload failed (${response.status})`);
  }
  return path;
}
