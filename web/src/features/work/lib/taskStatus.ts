/**
 * Agent task status, kind 30624 (web redesign Phase 8; wire format in
 * docs/plans/2026-09-29-web-redesign/phase-8.md).
 *
 * The member-readable projection of an agent's turn in a channel. Three `d`
 * namespaces share the kind:
 *
 *   turn:<channel>    lifecycle — written by the ACP harness: running, then
 *                     done | error | cancelled. Re-published every 60 s while
 *                     the turn runs, so its age IS the heartbeat.
 *   detail:<channel>  title / progress — written by `buzz status set`, bound
 *                     to a lifecycle head by its `turn` id (D8.3: a title from
 *                     an earlier turn never shows against a new one).
 *
 *   job:<channel>:<id> background job — independent lifecycle with a 60 s beat.
 *
 * The relay validates every head (`buzz-core/src/task_status.rs`); this parser
 * mirrors those rules rather than trusting them, and drops — never coerces —
 * anything that does not fit.
 *
 * All namespaces are ADDRESSABLE: the relay keeps one head per (author, d).
 * The store below therefore holds two views: the newest head per (author,
 * channel) for Running, and every terminal head it has seen (per turn) for
 * Done today, which a later turn in the same channel would otherwise replace.
 */

export const KIND_AGENT_TASK_STATUS = 30624;
/** D8.5: a running head older than this reads "no heartbeat". */
export const STATUS_STALE_S = 180;
/** A job without a beat for more than five minutes is dropped. */
export const JOB_STALE_S = 300;
/** Lookback for the REQ (phase-8 client rule 5). */
export const STATUS_LOOKBACK_S = 86_400;

export type TaskState = "running" | "done" | "error" | "cancelled";

export interface TaskProgress {
  done: number;
  total: number;
}

interface HeadBase {
  eventId: string;
  author: string;
  createdAt: number;
  channelId: string;
  turnId: string;
}

export interface LifecycleHead extends HeadBase {
  ns: "turn";
  state: TaskState;
  started: number;
  /** Null while running; required once terminal. */
  ended: number | null;
  /** First triggering event id. */
  trigger: string | null;
  /** Only with state=error, e.g. "harness-restart". */
  reason: string | null;
}

export interface DetailHead extends HeadBase {
  ns: "detail";
  title: string | null;
  progress: TaskProgress | null;
}

/** Independent background job, optionally bound to its launching turn. */
export interface JobHead extends Omit<LifecycleHead, "ns" | "turnId"> {
  ns: "job";
  jobId: string;
  role: string;
  model: string | null;
  title: string | null;
  /** Launching turn, when bound. */
  turnId: string | null;
}

export type TaskStatusHead = LifecycleHead | DetailHead | JobHead;

/** The bits of a signed event the parser reads. */
export interface StatusEvent {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/i;
// Strict end anchors mirror buzz-core's whole-string ASCII byte grammars.
const JOB_ID = /^[A-Za-z0-9._-]{1,64}(?![\s\S])/;
const ROLE = /^[a-z0-9_-]{1,32}(?![\s\S])/;
const MODEL = /^[A-Za-z0-9._:/-]{1,64}(?![\s\S])/;
const TURN_ID = /^[A-Za-z0-9._:-]{1,128}(?![\s\S])/;
const HEX64 = /^[0-9a-f]{64}(?![\s\S])/;
const DIGITS = /^[0-9]+(?![\s\S])/;
const STATES: ReadonlySet<string> = new Set([
  "running",
  "done",
  "error",
  "cancelled",
]);
const MAX_TITLE_CHARS = 120;
const MAX_PROGRESS_TOTAL = 100;
const MAX_REASON_LEN = 64;
const MAX_NOTE_BYTES = 2048;

function named(tags: readonly string[][], name: string): string[][] {
  return tags.filter((tag) => tag[0] === name);
}

/** The single value of a tag that must appear exactly once, else null. */
function one(tags: readonly string[][], name: string): string | null {
  const found = named(tags, name);
  return found.length === 1 && typeof found[0][1] === "string"
    ? found[0][1]
    : null;
}

/** `undefined` = absent; null = present but malformed or repeated. */
function atMostOne(
  tags: readonly string[][],
  name: string,
): string[] | null | undefined {
  const found = named(tags, name);
  if (found.length === 0) {
    return undefined;
  }
  return found.length === 1 && found[0].length >= 2 ? found[0] : null;
}

function unixSeconds(value: string | null | undefined): number | null {
  if (typeof value !== "string" || !DIGITS.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Parse one kind-30624 event; null for anything the relay would refuse. */
export function parseTaskStatus(event: StatusEvent): TaskStatusHead | null {
  if (event.kind !== KIND_AGENT_TASK_STATUS) {
    return null;
  }
  const tags = Array.isArray(event.tags) ? event.tags : [];
  const d = one(tags, "d");
  const h = one(tags, "h");
  if (d === null || h === null || !UUID.test(h)) {
    return null;
  }
  const base = {
    eventId: event.id,
    author: event.pubkey,
    createdAt: event.created_at,
    channelId: h,
  };
  if (d.startsWith("job:")) {
    const rest = d.slice(4);
    const separator = rest.indexOf(":");
    const jobId = rest.slice(separator + 1);
    if (
      separator < 0 ||
      rest.slice(0, separator) !== h ||
      !JOB_ID.test(jobId)
    ) {
      return null;
    }
    const turn = atMostOne(tags, "turn");
    const model = atMostOne(tags, "model");
    const role = one(tags, "role");
    const title = parseTitle(tags);
    const lifecycle = parseLifecycleFields(tags);
    if (
      turn === null ||
      (turn && !TURN_ID.test(turn[1])) ||
      model === null ||
      (model && !MODEL.test(model[1])) ||
      role === null ||
      !ROLE.test(role) ||
      title === undefined ||
      !lifecycle ||
      named(tags, "progress").length > 0 ||
      named(tags, "session").length > 0 ||
      event.content !== ""
    ) {
      return null;
    }
    return {
      ...base,
      ...lifecycle,
      ns: "job",
      jobId,
      role,
      model: model?.[1] ?? null,
      title,
      turnId: turn?.[1] ?? null,
    };
  }
  const turnId = one(tags, "turn");
  const ns = d.startsWith("turn:")
    ? "turn"
    : d.startsWith("detail:")
      ? "detail"
      : null;
  if (
    ns === null ||
    d.slice(ns.length + 1) !== h ||
    turnId === null ||
    !TURN_ID.test(turnId)
  ) {
    return null;
  }
  return ns === "turn"
    ? parseLifecycle(tags, event.content, { ...base, turnId })
    : parseDetail(tags, event.content, { ...base, turnId });
}

function parseLifecycle(
  tags: readonly string[][],
  content: string,
  base: HeadBase,
): LifecycleHead | null {
  if (
    named(tags, "title").length > 0 ||
    named(tags, "progress").length > 0 ||
    content !== ""
  ) {
    return null;
  }
  const session = atMostOne(tags, "session");
  if (
    session === null ||
    (session &&
      (session[1] === "" || new TextEncoder().encode(session[1]).length > 32))
  ) {
    return null;
  }
  const fields = parseLifecycleFields(tags);
  return fields ? { ...base, ns: "turn", ...fields } : null;
}

/** Shared with job heads, mirroring buzz-core's parse_lifecycle_fields. */
function parseLifecycleFields(
  tags: readonly string[][],
): Pick<
  LifecycleHead,
  "state" | "started" | "ended" | "trigger" | "reason"
> | null {
  const state = one(tags, "state");
  const started = unixSeconds(one(tags, "started"));
  if (state === null || !STATES.has(state) || started === null) {
    return null;
  }
  const endedTag = atMostOne(tags, "ended");
  let ended: number | null = null;
  if (state === "running") {
    if (endedTag !== undefined) {
      return null;
    }
  } else {
    ended = endedTag ? unixSeconds(endedTag[1]) : null;
    if (ended === null || ended < started) {
      return null;
    }
  }
  const triggerTag = atMostOne(tags, "e");
  if (triggerTag === null || (triggerTag && !HEX64.test(triggerTag[1]))) {
    return null;
  }
  const reasonTag = atMostOne(tags, "reason");
  if (
    reasonTag === null ||
    (reasonTag &&
      (state !== "error" ||
        reasonTag[1] === "" ||
        new TextEncoder().encode(reasonTag[1]).length > MAX_REASON_LEN))
  ) {
    return null;
  }
  return {
    state: state as TaskState,
    started,
    ended,
    trigger: triggerTag ? triggerTag[1] : null,
    reason: reasonTag ? reasonTag[1] : null,
  };
}

function parseDetail(
  tags: readonly string[][],
  content: string,
  base: HeadBase,
): DetailHead | null {
  for (const lifecycleOnly of ["state", "started", "ended", "reason"]) {
    if (named(tags, lifecycleOnly).length > 0) {
      return null;
    }
  }
  if (new TextEncoder().encode(content ?? "").length > MAX_NOTE_BYTES) {
    return null;
  }
  const title = parseTitle(tags);
  if (title === undefined) {
    return null;
  }
  const progressTag = atMostOne(tags, "progress");
  if (progressTag === null) {
    return null;
  }
  let progress: TaskProgress | null = null;
  if (progressTag) {
    if (progressTag.length !== 3) {
      return null;
    }
    const done = unixSeconds(progressTag[1]);
    const total = unixSeconds(progressTag[2]);
    if (
      done === null ||
      total === null ||
      total < 1 ||
      total > MAX_PROGRESS_TOTAL ||
      done > total
    ) {
      return null;
    }
    progress = { done, total };
  }
  if (title === null && progress === null) {
    return null;
  }
  return { ...base, ns: "detail", title, progress };
}

/** undefined means malformed; null means absent. Counts Unicode scalar values like Rust. */
function parseTitle(tags: readonly string[][]): string | null | undefined {
  const tag = atMostOne(tags, "title");
  if (tag === null) return undefined;
  if (!tag) return null;
  const chars = [...tag[1]].length;
  return chars > 0 && chars <= MAX_TITLE_CHARS ? tag[1] : undefined;
}

// ---- the store -----------------------------------------------------------------

/** Title and progress for one turn, each from the newest detail that set it. */
export interface TurnDetail {
  title: string | null;
  titleAt: number;
  progress: TaskProgress | null;
  progressAt: number;
}

export interface StatusStore {
  /** Newest lifecycle head per `author|channel` — the addressable head. */
  current: ReadonlyMap<string, LifecycleHead>;
  /** Independent addressable job heads per author|channel|job id. */
  jobs: ReadonlyMap<string, JobHead>;
  /** Every terminal lifecycle head seen, per `author|channel|turn`. */
  ended: ReadonlyMap<string, LifecycleHead>;
  /** Per `author|channel|turn`. */
  details: ReadonlyMap<string, TurnDetail>;
}

export const EMPTY_STATUS_STORE: StatusStore = {
  current: new Map(),
  jobs: new Map(),
  ended: new Map(),
  details: new Map(),
};

export function turnKey(author: string, channelId: string, turnId: string) {
  return `${author}|${channelId}|${turnId}`;
}

/** NIP-01 replaceable order: newer wins; on a tie the LOWER id wins. */
function newer(
  candidate: { createdAt: number; eventId: string },
  existing: { createdAt: number; eventId: string } | undefined,
): boolean {
  if (!existing) {
    return true;
  }
  return (
    candidate.createdAt > existing.createdAt ||
    (candidate.createdAt === existing.createdAt &&
      candidate.eventId < existing.eventId)
  );
}

/**
 * Fold heads into the store. Returns the SAME store when nothing changed, so
 * a replayed or superseded event costs no render.
 *
 * A detail head carrying only progress keeps the turn's title (and the other
 * way round): `buzz status set --progress 2/3` after `--title …` replaces the
 * relay's head, but it is still the same turn doing the same thing.
 */
export function foldStatus(
  store: StatusStore,
  heads: readonly TaskStatusHead[],
): StatusStore {
  let jobs: Map<string, JobHead> | null = null;
  let current: Map<string, LifecycleHead> | null = null;
  let ended: Map<string, LifecycleHead> | null = null;
  let details: Map<string, TurnDetail> | null = null;
  for (const head of heads) {
    if (head.ns === "job") {
      const key = turnKey(head.author, head.channelId, head.jobId);
      if (newer(head, (jobs ?? store.jobs).get(key))) {
        jobs = jobs ?? new Map(store.jobs);
        jobs.set(key, head);
      }
      continue;
    }
    const key = turnKey(head.author, head.channelId, head.turnId);
    if (head.ns === "turn") {
      const slot = `${head.author}|${head.channelId}`;
      const map = current ?? store.current;
      if (newer(head, map.get(slot))) {
        current = current ?? new Map(store.current);
        current.set(slot, head);
      }
      if (head.state !== "running") {
        const endedMap = ended ?? store.ended;
        if (newer(head, endedMap.get(key))) {
          ended = ended ?? new Map(store.ended);
          ended.set(key, head);
        }
      }
      continue;
    }
    const map = details ?? store.details;
    const previous = map.get(key);
    const next: TurnDetail = previous
      ? { ...previous }
      : { title: null, titleAt: -1, progress: null, progressAt: -1 };
    let changed = false;
    if (head.title !== null && head.createdAt > next.titleAt) {
      next.title = head.title;
      next.titleAt = head.createdAt;
      changed = true;
    }
    if (head.progress !== null && head.createdAt > next.progressAt) {
      next.progress = head.progress;
      next.progressAt = head.createdAt;
      changed = true;
    }
    if (changed) {
      details = details ?? new Map(store.details);
      details.set(key, next);
    }
  }
  if (!current && !ended && !details && !jobs) {
    return store;
  }
  return {
    current: current ?? store.current,
    jobs: jobs ?? store.jobs,
    ended: ended ?? store.ended,
    details: details ?? store.details,
  };
}

/** Drop ended turns and details older than `floorS`, so a day cannot pile up. */
export function pruneStatus(store: StatusStore, floorS: number): StatusStore {
  const jobs = new Map(
    [...store.jobs].filter(([, head]) => head.createdAt >= floorS),
  );
  const ended = new Map(
    [...store.ended].filter(([, head]) => head.createdAt >= floorS),
  );
  const details = new Map(
    [...store.details].filter(
      ([, detail]) => Math.max(detail.titleAt, detail.progressAt) >= floorS,
    ),
  );
  if (
    ended.size === store.ended.size &&
    details.size === store.details.size &&
    jobs.size === store.jobs.size
  ) {
    return store;
  }
  return { current: store.current, ended, details, jobs };
}

// ---- reads ---------------------------------------------------------------------

/** One turn as the Work rows read it: lifecycle plus its bound detail. */
export interface StatusTurn {
  agentPubkey: string;
  channelId: string;
  turnId: string;
  state: TaskState;
  started: number;
  ended: number | null;
  /** The head's own time — for a running turn, its last heartbeat. */
  beatAt: number;
  trigger: string | null;
  reason: string | null;
  title: string | null;
  progress: TaskProgress | null;
}

function toTurn(head: LifecycleHead, store: StatusStore): StatusTurn {
  const detail = store.details.get(
    turnKey(head.author, head.channelId, head.turnId),
  );
  return {
    agentPubkey: head.author,
    channelId: head.channelId,
    turnId: head.turnId,
    state: head.state,
    started: head.started,
    ended: head.ended,
    beatAt: head.createdAt,
    trigger: head.trigger,
    reason: head.reason,
    // D8.3 by construction: details are keyed by the lifecycle's own turn.
    title: detail?.title ?? null,
    progress: detail?.progress ?? null,
  };
}

/** The current turn per (agent, channel) — one row each, whatever its state. */
export function currentTurns(store: StatusStore): StatusTurn[] {
  return [...store.current.values()].map((head) => toTurn(head, store));
}

/** Title and progress for a turn the observer frames know about. */
export function detailFor(
  store: StatusStore,
  agentPubkey: string,
  channelId: string,
  turnId: string,
): TurnDetail | null {
  return store.details.get(turnKey(agentPubkey, channelId, turnId)) ?? null;
}

/** Has the harness said this turn is over? */
export function hasEnded(
  store: StatusStore,
  agentPubkey: string,
  channelId: string,
  turnId: string,
): boolean {
  return store.ended.has(turnKey(agentPubkey, channelId, turnId));
}

/** Every turn that ended at or after `sinceS` (local midnight for Done today). */
export function endedTurns(store: StatusStore, sinceS: number): StatusTurn[] {
  const out: StatusTurn[] = [];
  for (const head of store.ended.values()) {
    if ((head.ended ?? head.createdAt) >= sinceS) {
      out.push(toTurn(head, store));
    }
  }
  return out;
}

/** Every trigger a status head names, per agent — a queued 👀 it answers is not queued. */
export function statusTriggers(store: StatusStore): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const head of [
    ...store.current.values(),
    ...store.ended.values(),
    ...store.jobs.values(),
  ]) {
    if (!head.trigger) {
      continue;
    }
    const set = out.get(head.author) ?? new Set<string>();
    set.add(head.trigger);
    out.set(head.author, set);
  }
  return out;
}

/** A job as the Work rows read it; dropped is derived, never published. */
export interface StatusJob {
  agentPubkey: string;
  channelId: string;
  jobId: string;
  role: string;
  engine: string | null;
  title: string | null;
  state: TaskState | "dropped";
  started: number;
  ended: number | null;
  beatAt: number;
  trigger: string | null;
  reason: string | null;
}

/** Model-prefix display label; unknown ids remain intact. */
export function engineLabel(model: string | null): string | null {
  if (model === null) return null;
  if (/^(gpt|o\d)/i.test(model)) return "GPT";
  if (/^(claude|opus|sonnet|haiku|fable)/i.test(model)) return "Claude";
  if (/^glm/i.test(model)) return "GLM";
  return model;
}

function toJob(
  head: JobHead,
  state: StatusJob["state"] = head.state,
): StatusJob {
  return {
    agentPubkey: head.author,
    channelId: head.channelId,
    jobId: head.jobId,
    role: head.role,
    engine: engineLabel(head.model),
    title: head.title,
    state,
    started: head.started,
    ended: head.ended,
    beatAt: head.createdAt,
    trigger: head.trigger,
    reason: head.reason,
  };
}

/** Running jobs whose heartbeat is no more than 300 seconds old. */
export function jobsRunning(store: StatusStore, nowS: number): StatusJob[] {
  return [...store.jobs.values()]
    .filter(
      (head) =>
        head.state === "running" && nowS - head.createdAt <= JOB_STALE_S,
    )
    .map((head) => toJob(head));
}

/** Terminal jobs and dropped heartbeats since the day floor. */
export function jobsFinished(
  store: StatusStore,
  sinceS: number,
  nowS: number,
): StatusJob[] {
  return [...store.jobs.values()].flatMap((head) => {
    if (head.state !== "running") {
      return (head.ended ?? head.createdAt) >= sinceS ? [toJob(head)] : [];
    }
    return nowS - head.createdAt > JOB_STALE_S && head.createdAt >= sinceS
      ? [toJob(head, "dropped")]
      : [];
  });
}

// ---- progress segments ---------------------------------------------------------

/** Past this many steps the row says "4 of 7" instead of drawing segments. */
export const MAX_SEGMENTS = 5;

export type Segment = "done" | "current" | "todo";

/**
 * The segments a progress bar draws (Main artboard: finished steps solid, the
 * step in hand pulsing, the rest faint). `done` counts FINISHED steps, so
 * 1/3 is [done, current, todo] and 3/3 is all done. Null when the total is
 * too long to draw at row size — the caller writes "n of m".
 */
export function progressSegments(progress: TaskProgress): Segment[] | null {
  const { done, total } = progress;
  if (total < 1 || total > MAX_SEGMENTS || done < 0 || done > total) {
    return null;
  }
  return Array.from({ length: total }, (_, index) =>
    index < done ? "done" : index === done ? "current" : "todo",
  );
}

/** "1 of 3 steps done". */
export function progressLabel(progress: TaskProgress): string {
  return `${progress.done} of ${progress.total} steps done`;
}

/** "4 of 7" for a total too long to draw; null when segments will show. */
export function progressText(progress: TaskProgress | null): string | null {
  if (!progress || progressSegments(progress)) {
    return null;
  }
  return `${progress.done} of ${progress.total}`;
}
