import type {
  AgentActivityRenderClass,
  TranscriptItem,
} from "./agentSessionTypes";
import { classifyToolItem } from "./agentSessionToolClassifier";

type ToolItem = Extract<TranscriptItem, { type: "tool" }>;

/**
 * Which render classes may join a tool-chain run.
 *
 * Exhaustive by construction: adding a render class to
 * `AgentActivityRenderClass` forces a decision here rather than silently
 * opting the new class into (or out of) chaining.
 *
 * The exclusions are deliberate, not incidental:
 *  - `raw-rail` / `suppressed` — the ambient safety net. Collapsing ground
 *    truth or deliberately-unrendered noise into a chain would hide the two
 *    classes that exist precisely to be a floor.
 *  - `status` — turn/tool heartbeat (e.g. "Context compacted"). Spine content
 *    that changes how every later step should be read; it must not disappear
 *    into a collapsed card.
 *  - `permission` / `thought` — intervention points and reasoning. A control
 *    gate the reader may need to act on never collapses, and thoughts are read
 *    as prose rather than as steps.
 *
 * Everything else chains, including `message` (so sent-message previews keep
 * rendering inside a chain body) and `error` (so a failed step is a *member*
 * of the run that failed rather than a row that shatters it — the card then
 * stays open and highlights it).
 */
const CHAIN_ELIGIBLE_RENDER_CLASSES = {
  "file-read": true,
  "file-edit": true,
  "relay-op": true,
  "skill-read": true,
  message: true,
  generic: true,
  image: true,
  shell: true,
  plan: true,
  error: true,
  permission: false,
  "raw-rail": false,
  suppressed: false,
  thought: false,
  status: false,
} satisfies Record<AgentActivityRenderClass, boolean>;

/** Runs shorter than this render as ordinary standalone rows. */
export const TOOL_RUN_MINIMUM_STEPS = 2;

/**
 * Coarse buckets used to headline a heterogeneous run. Ordered by salience:
 * writes and outbound speech before reads, matching "failures rise; reads
 * recede". The order doubles as the tie-break when two buckets are equally
 * common.
 */
export type ToolRunBucket =
  | "edit"
  | "message"
  | "relay"
  | "command"
  | "plan"
  | "image"
  | "tool"
  | "review";

const BUCKET_SALIENCE: ToolRunBucket[] = [
  "edit",
  "message",
  "relay",
  "command",
  "plan",
  "image",
  "tool",
  "review",
];

const BUCKET_PHRASES: Record<
  ToolRunBucket,
  {
    active: { verb: string; object: string };
    past: { verb: string; object: string };
  }
> = {
  edit: {
    active: { verb: "Editing", object: "files" },
    past: { verb: "Edited", object: "files" },
  },
  message: {
    active: { verb: "Sending", object: "messages" },
    past: { verb: "Sent", object: "messages" },
  },
  relay: {
    active: { verb: "Updating", object: "Buzz" },
    past: { verb: "Ran", object: "Buzz relay ops" },
  },
  command: {
    active: { verb: "Running", object: "commands" },
    past: { verb: "Ran", object: "commands" },
  },
  plan: {
    active: { verb: "Updating", object: "todos" },
    past: { verb: "Updated", object: "todos" },
  },
  image: {
    active: { verb: "Viewing", object: "images" },
    past: { verb: "Viewed", object: "images" },
  },
  tool: {
    active: { verb: "Running", object: "tools" },
    past: { verb: "Ran", object: "tool calls" },
  },
  review: {
    active: { verb: "Reviewing", object: "files" },
    past: { verb: "Read", object: "files" },
  },
};

/**
 * Aggregate lifecycle of a run.
 *
 * `running` deliberately wins over `error` for the *phase* (the spec's
 * "running spinner while any step executes"). A failure is never masked by
 * that: `hasError` is tracked separately, a live run is expanded by default,
 * and the failing step carries its own highlight — so an error inside a
 * still-running chain is visible in the body while the header keeps reporting
 * that work is ongoing.
 */
export type ToolRunPhase = "running" | "done" | "error";

/** Verb/object/outcome headline for a run, pre-split for `ActivityRowLabel`. */
export type ToolRunHeadline = {
  verb: string;
  /** Object phrase; carries the count for a homogeneous run ("3 files"). */
  object: string | null;
  /** Trailing clause — "4 steps" while collapsed, "step 3" while live. */
  detail: string | null;
};

export type ToolRunAggregate = {
  phase: ToolRunPhase;
  hasError: boolean;
  /** Number of steps in the run. */
  count: number;
  /** 1-based position of the step currently executing, if any. */
  activeStep: number | null;
  /** Count of steps that failed. */
  errorCount: number;
};

/** Whether a transcript item may join a tool-chain run. */
export function isToolRunEligible(item: TranscriptItem): boolean {
  if (item.type !== "tool") return false;
  return CHAIN_ELIGIBLE_RENDER_CLASSES[toolRunRenderClass(item)] === true;
}

/** Effective render class for a tool item (descriptor fallback included). */
export function toolRunRenderClass(item: ToolItem): AgentActivityRenderClass {
  const descriptor = item.descriptor ?? classifyToolItem(item);
  return item.renderClass ?? descriptor.renderClass;
}

/**
 * Semantic identity used to decide whether a run is homogeneous. Falls back to
 * the render class when the classifier supplied no `groupKey`.
 */
export function toolRunGroupKey(item: ToolItem): string {
  const descriptor = item.descriptor ?? classifyToolItem(item);
  return descriptor.groupKey ?? toolRunRenderClass(item);
}

function toolRunBucket(item: ToolItem): ToolRunBucket {
  switch (toolRunRenderClass(item)) {
    case "file-edit":
      return "edit";
    case "message":
      return "message";
    case "relay-op":
      return "relay";
    case "shell":
      return "command";
    case "plan":
      return "plan";
    case "image":
      return "image";
    case "file-read":
    case "skill-read":
      return "review";
    default:
      // Generic tools and failed steps (whose original class is lost when the
      // classifier reclassifies them to "error") report honestly as tool work.
      return "tool";
  }
}

function isToolStepRunning(item: ToolItem): boolean {
  return item.status === "executing" || item.status === "pending";
}

function isToolStepFailed(item: ToolItem): boolean {
  return item.isError || item.status === "failed";
}

/** Aggregate status across a run's steps. */
export function summarizeToolRunStatus(items: ToolItem[]): ToolRunAggregate {
  let activeStep: number | null = null;
  let errorCount = 0;

  items.forEach((item, index) => {
    if (activeStep === null && isToolStepRunning(item)) {
      activeStep = index + 1;
    }
    if (isToolStepFailed(item)) {
      errorCount += 1;
    }
  });

  const hasError = errorCount > 0;
  const phase: ToolRunPhase =
    activeStep !== null ? "running" : hasError ? "error" : "done";

  return { phase, hasError, count: items.length, activeStep, errorCount };
}

/**
 * Past-tense label for a run whose steps all share one semantic group key.
 * These are the specific, countable sentences ("Read 3 files") the transcript
 * has always used; keep them verbatim so a homogeneous run reads no differently
 * than it did before chains existed.
 */
function homogeneousHeadline(item: ToolItem, count: number): ToolRunHeadline {
  const descriptor = item.descriptor ?? classifyToolItem(item);
  const renderClass = toolRunRenderClass(item);
  const plural = count === 1 ? "" : "s";

  if (renderClass === "file-edit") {
    return { verb: "Edited", object: `${count} file${plural}`, detail: null };
  }
  if (renderClass === "file-read") {
    return { verb: "Read", object: `${count} file${plural}`, detail: null };
  }
  if (renderClass === "skill-read") {
    return { verb: "Read", object: `${count} skill${plural}`, detail: null };
  }
  if (renderClass === "shell") {
    return { verb: "Ran", object: `${count} command${plural}`, detail: null };
  }
  if (renderClass === "relay-op") {
    return {
      verb: "Ran",
      object: `${count} Buzz relay op${plural}`,
      detail: null,
    };
  }
  if (renderClass === "message") {
    return { verb: "Sent", object: `${count} message${plural}`, detail: null };
  }
  if (renderClass === "image") {
    return { verb: "Viewed", object: `${count} image${plural}`, detail: null };
  }
  return { verb: descriptor.label, object: `×${count}`, detail: null };
}

/** Dominant bucket for a heterogeneous run. */
export function dominantToolRunBucket(items: ToolItem[]): ToolRunBucket {
  const counts = new Map<ToolRunBucket, number>();
  for (const item of items) {
    const bucket = toolRunBucket(item);
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }

  let dominant: ToolRunBucket = "tool";
  let dominantCount = -1;
  // Walk in salience order so an equally-common write bucket beats a read one.
  for (const bucket of BUCKET_SALIENCE) {
    const count = counts.get(bucket) ?? 0;
    if (count > dominantCount) {
      dominant = bucket;
      dominantCount = count;
    }
  }
  return dominant;
}

/**
 * Headline for a run: verb, object, and an optional trailing clause.
 *
 * A live run reads as active and reports how far it has got
 * ("Reviewing files · step 3"). A settled run reads as an outcome: homogeneous
 * runs keep their specific countable sentence ("Read 4 files"), heterogeneous
 * runs name the dominant kind of work and carry the step count in the detail
 * clause ("Read files · 6 steps") rather than pretending to be one thing.
 */
export function summarizeToolRunHeadline(
  items: ToolItem[],
  aggregate: ToolRunAggregate,
): ToolRunHeadline {
  if (items.length === 0) {
    return { verb: "Working…", object: null, detail: null };
  }

  const groupKey = toolRunGroupKey(items[0]);
  const homogeneous = items.every((item) => toolRunGroupKey(item) === groupKey);

  if (aggregate.phase === "running") {
    const bucket = homogeneous
      ? toolRunBucket(items[0])
      : dominantToolRunBucket(items);
    const phrase = BUCKET_PHRASES[bucket].active;
    return {
      verb: phrase.verb,
      object: phrase.object,
      detail:
        aggregate.activeStep === null ? null : `step ${aggregate.activeStep}`,
    };
  }

  if (homogeneous) {
    return homogeneousHeadline(items[0], items.length);
  }

  const phrase = BUCKET_PHRASES[dominantToolRunBucket(items)].past;
  return {
    verb: phrase.verb,
    object: phrase.object,
    detail: `${items.length} steps`,
  };
}

/** Earliest start instant across a run, in epoch ms. */
export function toolRunStartedAtMs(items: ToolItem[]): number | null {
  let earliest: number | null = null;
  for (const item of items) {
    const parsed = Date.parse(item.startedAt || item.timestamp);
    if (Number.isNaN(parsed)) continue;
    if (earliest === null || parsed < earliest) earliest = parsed;
  }
  return earliest;
}

/**
 * Latest completion instant across a run, in epoch ms — null unless every step
 * has settled, so a partially-finished run never reports a final duration.
 */
export function toolRunCompletedAtMs(items: ToolItem[]): number | null {
  let latest: number | null = null;
  for (const item of items) {
    if (!item.completedAt) return null;
    const parsed = Date.parse(item.completedAt);
    if (Number.isNaN(parsed)) return null;
    if (latest === null || parsed > latest) latest = parsed;
  }
  return latest;
}

/**
 * Wall-clock span of a run in ms: first start to last completion once settled,
 * or first start to `now` while still executing. Null when unmeasurable.
 */
export function toolRunElapsedMs(
  items: ToolItem[],
  now: number,
): number | null {
  const startedAt = toolRunStartedAtMs(items);
  if (startedAt === null) return null;
  const completedAt = toolRunCompletedAtMs(items);
  const end = completedAt ?? now;
  const elapsed = end - startedAt;
  return elapsed < 0 ? null : elapsed;
}
