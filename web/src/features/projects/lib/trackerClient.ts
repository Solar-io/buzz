/**
 * The tracker sidecar client — project ownership and open work items for the
 * projects page.
 *
 * The relay's project registry is a *pointer* store: every identity in it is a
 * pubkey, because kind:30621 carries no human-name tag. "Who is primary on
 * responsibility" is a fact the registry cannot express, so it lives in a
 * sidecar JSON document (Dwight's tracker ledger, emitted to
 * `~/.buzz/WORKING_STATE/tracker.json` and served beside the changelog at
 * `:6451/tracker.json`).
 *
 * Every reader here is deliberately forgiving. The sidecar is hand-maintained
 * data: unknown fields are ignored, malformed entries are dropped, and any
 * failure — network, parse, join — resolves to "no tracker data", which
 * renders the page exactly as it did before this module existed. A reformat
 * on the writer's side must never be able to break the page.
 */

/** One tracked work item. `status: "done"` is the only closed state. */
export type TrackerItem = {
  id: string;
  /** Registry `d` slug (preferred) or display name of the owning project. */
  project: string;
  kind: string;
  status: string;
  /** Null inherits the project's primary owner. */
  owner: string | null;
  summary: string;
};

export type TrackerProject = {
  slug: string;
  owner: string;
};

export type TrackerDocument = {
  generated: string | null;
  projects: TrackerProject[];
  items: TrackerItem[];
};

/** What a card or detail page renders for one registry project. */
export type TrackerEntry = {
  owner: string;
  /** Items whose status is anything other than "done". */
  openItems: TrackerItem[];
  generated: string | null;
};

export type TrackerIndex = {
  /**
   * Registry key (d slug or display name, exact and lowercased — same entry
   * object may sit under several keys) → entry.
   */
  byProject: Map<string, TrackerEntry>;
};

const SIDECAR_PORT = "6451";

/** Origin serving the changelog and the tracker sidecar (same host as the SPA). */
export function sidecarOrigin(): string | null {
  if (typeof location === "undefined" || !location.hostname) return null;
  return `https://${location.hostname}:${SIDECAR_PORT}`;
}

export function trackerJsonUrl(): string | null {
  const env =
    typeof import.meta !== "undefined"
      ? (import.meta.env as Record<string, string | undefined>)
      : undefined;
  if (env?.VITE_TRACKER_URL) return env.VITE_TRACKER_URL;
  const base = sidecarOrigin();
  return base ? `${base}/tracker.json` : null;
}

export function changelogUrl(): string | null {
  const base = sidecarOrigin();
  return base ? `${base}/changelog.md` : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function parseItem(value: unknown): TrackerItem | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const id = asString(record.id);
  const project = asString(record.project);
  const summary = asString(record.summary);
  if (!id || !project || !summary) return null;
  return {
    id,
    project,
    kind: asString(record.kind) ?? "task",
    status: asString(record.status) ?? "open",
    owner: asString(record.owner),
    summary,
  };
}

function parseProject(value: unknown): TrackerProject | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const slug = asString(record.slug ?? record.name ?? record.project);
  const owner = asString(record.owner);
  if (!slug || !owner) return null;
  return { slug, owner };
}

/**
 * Lenient parse of the sidecar document. Returns null for anything that is
 * not recognizably a tracker document — the caller renders "no tracker data",
 * never an error.
 */
export function parseTrackerDocument(value: unknown): TrackerDocument | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.items) && !Array.isArray(record.projects)) {
    return null;
  }
  return {
    generated: asString(record.generated),
    projects: Array.isArray(record.projects)
      ? record.projects.flatMap((entry) => {
          const parsed = parseProject(entry);
          return parsed ? [parsed] : [];
        })
      : [],
    items: Array.isArray(record.items)
      ? record.items.flatMap((entry) => {
          const parsed = parseItem(entry);
          return parsed ? [parsed] : [];
        })
      : [],
  };
}

/**
 * Folds the document into a lookup. Each project — whether declared in
 * `projects` or introduced by an item — gets ONE entry object, registered
 * under every key a lookup might reasonably use for it: the slug as written,
 * and its lowercase.
 *
 * `registry` (the folded project collection's dtag/name pairs) fuses citation
 * islands: an item citing "Crypto Tracker" and a declaration citing
 * "crypto-tracker" are the same project, but key-aliasing alone cannot know
 * that — without the pairing the two entries would split ownership and count
 * the project's items between them. Anything fuzzier than these keys would
 * silently drop items the moment a name changes.
 */
export function buildTrackerIndex(
  doc: TrackerDocument,
  registry?: ReadonlyArray<{ dtag: string; name: string }>,
): TrackerIndex {
  const byProject = new Map<string, TrackerEntry>();
  const entryFor = (key: string): TrackerEntry => {
    const existing = byProject.get(key);
    if (existing) return existing;
    const folded = byProject.get(key.toLowerCase());
    if (folded) {
      // Same project cited in different case: one entry, aliased under both
      // keys, so the map never disagrees with itself.
      byProject.set(key, folded);
      return folded;
    }
    const entry: TrackerEntry = {
      owner: "",
      openItems: [],
      generated: doc.generated,
    };
    byProject.set(key, entry);
    byProject.set(key.toLowerCase(), entry);
    return entry;
  };

  for (const project of doc.projects) {
    const entry = entryFor(project.slug);
    if (!entry.owner) entry.owner = project.owner;
  }

  for (const item of doc.items) {
    const entry = entryFor(item.project);
    // An item may carry the only owner an undeclared project gets.
    if (!entry.owner && item.owner) entry.owner = item.owner;
    if (isOpenTrackerItem(item)) entry.openItems.push(item);
  }

  for (const { dtag, name } of registry ?? []) {
    // Existence, not entryFor: creating an entry here would put a phantom
    // "Primary: unassigned" on every card the sidecar never mentions. The
    // registry pairs fuse islands; they do not speak for the sidecar.
    const canonical =
      byProject.get(dtag) ?? byProject.get(dtag.toLowerCase());
    if (!canonical) continue;
    const island = byProject.get(name) ?? byProject.get(name.toLowerCase());
    if (island && island !== canonical) {
      if (!canonical.owner) canonical.owner = island.owner;
      canonical.openItems.push(...island.openItems);
      byProject.set(name, canonical);
      byProject.set(name.toLowerCase(), canonical);
    }
  }

  return { byProject };
}

/** "done" (any case, whitespace-tolerant) is the only closed status. */
export function isOpenTrackerItem(item: TrackerItem): boolean {
  return item.status.toLowerCase() !== "done";
}

/**
 * The entry for one registry project, or null when the sidecar says nothing
 * about it. Join preference mirrors the index keys: exact d slug, exact
 * display name, then lowercased — nothing fuzzier.
 */
export function lookupTrackerEntry(
  index: TrackerIndex | null,
  project: { dtag: string; name: string },
): TrackerEntry | null {
  if (!index) return null;
  const candidates = [
    project.dtag,
    project.name,
    project.dtag.toLowerCase(),
    project.name.toLowerCase(),
  ];
  for (const key of candidates) {
    const entry = index.byProject.get(key);
    if (entry) return entry;
  }
  return null;
}

/** Fetches and parses the sidecar; null on any failure, never throws. */
export async function fetchTrackerDocument(
  url: string,
  signal?: AbortSignal,
): Promise<TrackerDocument | null> {
  try {
    const response = await fetch(url, { signal });
    if (!response.ok) return null;
    return parseTrackerDocument(await response.json());
  } catch {
    return null;
  }
}
