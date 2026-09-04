/**
 * Presence model — kind:20001, the relay's Redis-backed status.
 *
 * # Why this module exists at all
 *
 * The web client publishes presence exactly once, on connect
 * (`repos.tsx` → `sendPresence(session, "online")`). The relay stores it with
 * a **180-second TTL** and expects a heartbeat every 60 seconds
 * (`crates/buzz-pubsub/src/lib.rs`: "Set presence with 180s TTL. Call on
 * connect and every 60s heartbeat."). So today every web user drops to
 * *offline* for everyone else three minutes after the tab loads and never
 * comes back. That is the single user-visible presence bug, and the reason the
 * heartbeat constants below are the load-bearing part of this file.
 *
 * # Deliberate divergence from the desktop
 *
 * The desktop resolves "away" from **OS-wide** idle when Tauri can report it
 * (`getOsIdleSeconds`), falling back to in-app activity. A browser has no
 * OS-idle API, so only the fallback exists here — a web user who walks away
 * with Buzz open goes away after {@link PRESENCE_IDLE_TIMEOUT_MS} of no
 * pointer/key/wheel activity in the tab. Tab visibility is deliberately NOT an
 * input: "away" means the human left, never "this tab is in the background".
 *
 * Pure and import-free so `node --test` can load it directly.
 */

/** `KIND_PRESENCE_UPDATE` in crates/buzz-core/src/kind.rs. */
export const PRESENCE_KIND = 20001;

/**
 * Heartbeat cadence. The relay's TTL is three of these windows
 * (`PRESENCE_TTL_SECONDS`); raising this without raising the relay's TTL
 * first would make every client flicker offline between beats.
 */
export const PRESENCE_HEARTBEAT_INTERVAL_MS = 60_000;

/** The relay's own TTL, in seconds — three heartbeat windows. */
export const PRESENCE_TTL_SECONDS = 3 * (PRESENCE_HEARTBEAT_INTERVAL_MS / 1000);

/** No pointer/key/wheel activity for this long reads as "away". */
export const PRESENCE_IDLE_TIMEOUT_MS = 10 * 60_000;

/** How often the automatic status is re-derived from the activity clock. */
export const PRESENCE_STATUS_TICK_INTERVAL_MS = 30_000;

/** Activity events are noisy; record at most one per this window. */
export const PRESENCE_ACTIVITY_THROTTLE_MS = 1_000;

/**
 * A status the relay understands. `unknown` is a *reader-side* value for a
 * pubkey nobody has published for; it is never published.
 */
export type PresenceStatus = "online" | "away" | "offline";
export type ObservedPresenceStatus = PresenceStatus | "unknown";

/** What the viewer chose. `auto` follows the activity clock. */
export type PresencePreference = "auto" | "away" | "offline";

export interface PresenceEntry {
  pubkey: string;
  status: ObservedPresenceStatus;
  updatedAt: number;
}

/** The storage surface this module needs (injectable for tests). */
export interface PresenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Read a kind-20001 payload.
 *
 * Two wire shapes are accepted, and that is a superset of what the desktop
 * accepts on purpose: the current relay publishes a bare string, while older
 * publishers still emit `{"status":"online"}`. The desktop's
 * `parseLivePresenceEvent` rejects the JSON form outright; on the web the
 * legacy form is still arriving from long-lived agent sessions, and dropping
 * it would silently show those agents as offline.
 */
export function parsePresenceContent(content: string): ObservedPresenceStatus {
  let raw = content.trim();
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as { status?: unknown };
      if (typeof parsed.status === "string") {
        raw = parsed.status.trim();
      }
    } catch {
      return "unknown";
    }
  }
  return raw === "online" || raw === "away" || raw === "offline"
    ? raw
    : "unknown";
}

/**
 * Presence entry for one event, or null when it is not presence.
 *
 * The **author** is the subject, always. A `p` tag is not consulted: a client
 * can put any pubkey in a tag it signs, so honouring one would let anybody
 * publish anybody else's status. (The relay-signed snapshot path is the only
 * place a p-tag subject is trustworthy, and the browser never sees it.)
 */
export function presenceEntryFromEvent(event: {
  kind: number;
  pubkey: string;
  content: string;
  created_at: number;
}): PresenceEntry | null {
  if (event.kind !== PRESENCE_KIND) {
    return null;
  }
  return {
    pubkey: event.pubkey.toLowerCase(),
    status: parsePresenceContent(event.content),
    updatedAt: event.created_at,
  };
}

/** Latest event per author wins; ties keep the incumbent (no re-render). */
export function mergePresenceEntry(
  current: ReadonlyMap<string, PresenceEntry>,
  entry: PresenceEntry,
): Map<string, PresenceEntry> {
  const existing = current.get(entry.pubkey);
  if (existing && existing.updatedAt >= entry.updatedAt) {
    return current as Map<string, PresenceEntry>;
  }
  const next = new Map(current);
  next.set(entry.pubkey, entry);
  return next;
}

/** Human label for a status. */
export function presenceLabel(status: ObservedPresenceStatus): string {
  switch (status) {
    case "online":
      return "Active";
    case "away":
      return "Away";
    case "offline":
      return "Offline";
    default:
      return "Unknown";
  }
}

/** Dot fill for a status. */
export function presenceDotClass(status: ObservedPresenceStatus): string {
  switch (status) {
    case "online":
      return "bg-emerald-500";
    case "away":
      return "bg-amber-400";
    case "offline":
      return "bg-muted-foreground/35";
    default:
      return "bg-muted-foreground/25";
  }
}

/** Filled pill styling (colour carries the meaning; no dot). */
export function presenceChipClass(status: ObservedPresenceStatus): string {
  switch (status) {
    case "online":
      return "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400";
    case "away":
      return "bg-amber-500/15 text-amber-600 dark:text-amber-400";
    default:
      return "bg-muted-foreground/15 text-muted-foreground";
  }
}

/**
 * Automatic status from the activity clock.
 *
 * `lastActivityAt` in the future (clock skew, a stale ref) still reads as
 * online rather than flipping to away, because `now - future` is negative.
 */
export function resolveAutomaticPresenceStatus(
  lastActivityAt: number,
  now: number,
): PresenceStatus {
  return now - lastActivityAt >= PRESENCE_IDLE_TIMEOUT_MS ? "away" : "online";
}

/** The status to publish, given the viewer's choice and the activity clock. */
export function effectivePresenceStatus(
  preference: PresencePreference,
  automatic: PresenceStatus,
): PresenceStatus {
  if (preference === "offline") {
    return "offline";
  }
  if (preference === "away") {
    return "away";
  }
  return automatic;
}

/**
 * The preference a manual pick implies.
 *
 * Choosing "Active" is not a request to be pinned online forever — it is a
 * request to go back to following the activity clock, which is what the
 * desktop does (`status === "online" ? "auto" : status`). Pinning would leave
 * a user who walked away showing green indefinitely.
 */
export function preferenceForManualPick(
  status: PresenceStatus,
): PresencePreference {
  return status === "online" ? "auto" : status;
}

const PRESENCE_PREFERENCE_STORAGE_PREFIX = "buzz:presence-preference";

export function presencePreferenceStorageKey(pubkey: string): string {
  return `${PRESENCE_PREFERENCE_STORAGE_PREFIX}:${pubkey.toLowerCase()}`;
}

/**
 * Stored preference for one key, defaulting to `auto`.
 *
 * Keyed by pubkey because one browser can hold several identities, and
 * "invisible" must not leak from one to the next.
 */
export function readPresencePreference(
  storage: PresenceStorage | null | undefined,
  pubkey: string,
): PresencePreference {
  if (!storage || pubkey.length === 0) {
    return "auto";
  }
  let value: string | null = null;
  try {
    value = storage.getItem(presencePreferenceStorageKey(pubkey));
  } catch {
    return "auto";
  }
  return value === "away" || value === "offline" || value === "auto"
    ? value
    : "auto";
}

export function writePresencePreference(
  storage: PresenceStorage | null | undefined,
  pubkey: string,
  preference: PresencePreference,
): void {
  if (!storage || pubkey.length === 0) {
    return;
  }
  try {
    if (preference === "auto") {
      storage.removeItem(presencePreferenceStorageKey(pubkey));
      return;
    }
    storage.setItem(presencePreferenceStorageKey(pubkey), preference);
  } catch {
    // Private mode / quota — presence still works, it just forgets the choice.
  }
}
