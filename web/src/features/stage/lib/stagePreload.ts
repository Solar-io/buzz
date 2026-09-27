/**
 * Deck preload (design §6): fetch every frame of a Stage palette ahead of
 * its showing so a release swaps to an already-decoded bitmap.
 *
 * - Concurrency-limited (default 3), in order, with the frame AFTER the one
 *   on stage always first in line (`prioritize`).
 * - Each URL is fetched at most once per preloader (dedupe), and the default
 *   fetcher is `fetchSignedMedia`, which also dedupes app-wide through its
 *   object-URL cache that timeline rows share.
 * - A rejection is tolerated: that frame resolves null (fetch-on-show) and
 *   the rest keep loading.
 *
 * Fetch and decode are injected so this runs under `node --test`.
 */

export const STAGE_PRELOAD_CONCURRENCY = 3;

export interface DeckPreloaderDeps {
  /** URL → object URL (signed GET). */
  fetch: (url: string) => Promise<string>;
  /** Decode the fetched object URL so display does not flash. Optional. */
  decode?: (objectUrl: string) => Promise<unknown>;
  concurrency?: number;
}

export interface DeckPreloader {
  /** Queue URLs (in order) that are not already known. */
  enqueue(urls: readonly string[]): void;
  /** Move a queued URL to the front; queues it if unknown. */
  prioritize(url: string): void;
  /** Object URL once loaded, null when it failed. Queues if unknown. */
  whenReady(url: string): Promise<string | null>;
  /** Loaded object URL, or undefined if not (yet) available. */
  peek(url: string): string | undefined;
  /** Stop starting new fetches (in-flight ones settle normally). */
  dispose(): void;
}

interface Entry {
  promise: Promise<string | null>;
  resolve: (value: string | null) => void;
  started: boolean;
  value?: string | null;
}

export function createDeckPreloader(deps: DeckPreloaderDeps): DeckPreloader {
  const limit = Math.max(1, deps.concurrency ?? STAGE_PRELOAD_CONCURRENCY);
  const entries = new Map<string, Entry>();
  const queue: string[] = [];
  let inFlight = 0;
  let disposed = false;

  function entryFor(url: string): { entry: Entry; created: boolean } {
    const existing = entries.get(url);
    if (existing) return { entry: existing, created: false };
    let resolve: (value: string | null) => void = () => {};
    const promise = new Promise<string | null>((done) => {
      resolve = done;
    });
    const entry: Entry = { promise, resolve, started: false };
    entries.set(url, entry);
    return { entry, created: true };
  }

  function start(url: string, entry: Entry) {
    entry.started = true;
    inFlight += 1;
    const settle = (value: string | null) => {
      entry.value = value;
      entry.resolve(value);
      inFlight -= 1;
      drain();
    };
    let fetched: Promise<string>;
    try {
      fetched = deps.fetch(url);
    } catch (error) {
      fetched = Promise.reject(error);
    }
    fetched
      .then(async (objectUrl) => {
        if (deps.decode) {
          // A decode failure still leaves a usable object URL.
          await deps.decode(objectUrl).catch(() => {});
        }
        return objectUrl;
      })
      .then(settle, () => settle(null));
  }

  function drain() {
    while (!disposed && inFlight < limit && queue.length > 0) {
      const url = queue.shift() as string;
      const entry = entries.get(url);
      if (entry && !entry.started) start(url, entry);
    }
  }

  function enqueue(urls: readonly string[]) {
    for (const url of urls) {
      if (!url) continue;
      const { created } = entryFor(url);
      if (created) queue.push(url);
    }
    drain();
  }

  function prioritize(url: string) {
    if (!url) return;
    const { entry, created } = entryFor(url);
    if (entry.started) return;
    if (!created) {
      const index = queue.indexOf(url);
      if (index >= 0) queue.splice(index, 1);
    }
    queue.unshift(url);
    drain();
  }

  return {
    enqueue,
    prioritize,
    whenReady(url) {
      if (!entries.has(url)) prioritize(url);
      return (entries.get(url) as Entry).promise;
    },
    peek(url) {
      const value = entries.get(url)?.value;
      return value === null ? undefined : value;
    },
    dispose() {
      disposed = true;
      queue.length = 0;
    },
  };
}

/**
 * Preload a deck starting at `first` (the frame after the one on stage),
 * then the rest of the palette in order, then the frames before `first`.
 */
export function preloadDeck(
  urls: readonly string[],
  deps: DeckPreloaderDeps & { first?: number },
): DeckPreloader {
  const preloader = createDeckPreloader(deps);
  const first = Math.min(Math.max(0, deps.first ?? 0), urls.length);
  preloader.enqueue([...urls.slice(first), ...urls.slice(0, first)]);
  return preloader;
}
