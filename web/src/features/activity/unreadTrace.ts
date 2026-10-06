/**
 * Unread diagnostic trail (LEFT_NAV_ARCHITECTURE_REVIEW.md, invariant I3).
 *
 * "A toast fired and the row shows nothing" could not be decided from
 * evidence on 2026-10-05 because nothing recorded WHY a read marker moved.
 * Every marker move and every toastable arrival now lands in one bounded
 * ring buffer, readable from any console (prod bundle included) as
 * `window.__buzzUnreadTrace`. The next report is one dump away from an
 * answer: an arrival with `rowUnread: false`, or a `markerMoved` whose
 * `source` names another device's slot.
 *
 * Framework-free and allocation-light: it is called on every arrival.
 */

/** Ring size: enough for a few minutes of a busy workspace. */
export const UNREAD_TRACE_LIMIT = 200;

/**
 * Who moved a marker:
 * - `open`      this client marked the conversation it is showing
 * - `menu`      "Mark read" from a row menu
 * - `evict`     a deleted channel's marker was dropped
 * - `storage`   another tab of this browser wrote localStorage
 * - `sync:<id>` an NIP-RS blob from another install (slot / client id)
 */
export type MarkerSource =
  | "open"
  | "menu"
  | "evict"
  | "storage"
  | `sync:${string}`;

export interface MarkerMovedTrace {
  type: "markerMoved";
  /** Wall clock, ms. */
  at: number;
  id: string;
  from: number | null;
  to: number | null;
  source: MarkerSource;
}

export interface ArrivalTrace {
  type: "arrival";
  at: number;
  id: string;
  eventId: string | null;
  createdAt: number;
  /** A toast was shown for it. */
  toasted: boolean;
  /** Why not, when it was not (self, viewing, muted, unknown channel). */
  reason?: string;
  /** The row's unread state at the moment of the arrival. */
  rowUnread: boolean;
}

export type UnreadTraceEntry = MarkerMovedTrace | ArrivalTrace;

type Untimed<T> = T extends unknown ? Omit<T, "at"> : never;

const buffer: UnreadTraceEntry[] = [];

/** Append one entry, dropping the oldest past {@link UNREAD_TRACE_LIMIT}. */
export function traceUnread(entry: Untimed<UnreadTraceEntry>): void {
  buffer.push({ ...entry, at: Date.now() } as UnreadTraceEntry);
  if (buffer.length > UNREAD_TRACE_LIMIT) {
    buffer.splice(0, buffer.length - UNREAD_TRACE_LIMIT);
  }
}

/** A copy of the trail, oldest first. */
export function readUnreadTrace(): UnreadTraceEntry[] {
  return [...buffer];
}

/** Tests only: start from an empty trail. */
export function clearUnreadTrace(): void {
  buffer.length = 0;
}

// The console handle. A getter, so a dump is always current and a caller
// can never mutate the live buffer.
if (typeof window !== "undefined") {
  try {
    Object.defineProperty(window, "__buzzUnreadTrace", {
      configurable: true,
      get: readUnreadTrace,
    });
  } catch {
    // A frozen window (sandboxed frame) just goes without the handle.
  }
}
