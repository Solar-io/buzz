/**
 * "Who is new here" — a persisted ledger of roster pubkeys already seen.
 *
 * # Why a ledger, and not a diff of consecutive snapshots
 *
 * kind:13534 publication is eventual, not transactional: a failed post-commit
 * publish is repaired later by the relay's reconciler, and a reconciler-issued
 * snapshot is indistinguishable from a fresh one. So "this snapshot differs
 * from the last one I held" does not mean "someone joined" — it can equally
 * mean "the tab reconnected and re-received the same roster". Only a record of
 * the pubkeys we have already accounted for can answer the question the
 * feature actually asks.
 *
 * # Why `seeded` is a field rather than `pubkeys.length > 0`
 *
 * A community whose only member is the viewer seeds to an *empty* pubkey list
 * — the viewer is never recorded as new to themselves. Inferring "seeded" from
 * emptiness would classify the first genuine join as the seeding run and
 * swallow the one alert this exists for.
 *
 * Pure and import-free so `node --test` can load it directly.
 */

/**
 * Cap on *departed* pubkeys retained.
 *
 * A pubkey still on the roster can never be shed: the next snapshot presents
 * it again, the ledger no longer recognizes it, and it alerts as a fresh join
 * — forever. So the cap bounds only the tail of keys that have left, and the
 * real ceiling is the roster the relay can deliver in one event.
 */
export const JOIN_ALERT_DEPARTED_MAX = 2_000;

export interface JoinAlertLedger {
  seeded: boolean;
  /** Pubkeys already accounted for, oldest first. */
  pubkeys: string[];
}

export const EMPTY_JOIN_ALERT_LEDGER: JoinAlertLedger = {
  seeded: false,
  pubkeys: [],
};

export interface JoinAlertStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_PREFIX = "buzz:community-join-seen.v1";

/**
 * One ledger per (community, viewer).
 *
 * The relay URL stands in for the community id, which the browser client
 * never learns: the web client is single-relay per origin, and a different
 * relay is a different community by construction. Keyed by viewer too,
 * because two identities in one browser must not inherit each other's
 * "already seen" set.
 */
export function joinAlertStorageKey(
  relayUrl: string,
  viewerPubkey: string,
): string {
  return `${STORAGE_PREFIX}:${relayUrl.trim().toLowerCase()}:${viewerPubkey.trim().toLowerCase()}`;
}

export function readJoinAlertLedger(
  storage: JoinAlertStorage | null | undefined,
  key: string,
): JoinAlertLedger {
  if (!storage) {
    return EMPTY_JOIN_ALERT_LEDGER;
  }
  let raw: string | null = null;
  try {
    raw = storage.getItem(key);
  } catch {
    return EMPTY_JOIN_ALERT_LEDGER;
  }
  if (!raw) {
    return EMPTY_JOIN_ALERT_LEDGER;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return EMPTY_JOIN_ALERT_LEDGER;
    }
    const candidate = parsed as Partial<JoinAlertLedger>;
    if (!Array.isArray(candidate.pubkeys)) {
      return EMPTY_JOIN_ALERT_LEDGER;
    }
    return {
      seeded: candidate.seeded === true,
      pubkeys: candidate.pubkeys.filter(
        (pubkey): pubkey is string => typeof pubkey === "string",
      ),
    };
  } catch {
    return EMPTY_JOIN_ALERT_LEDGER;
  }
}

export function writeJoinAlertLedger(
  storage: JoinAlertStorage | null | undefined,
  key: string,
  ledger: JoinAlertLedger,
): void {
  if (!storage) {
    return;
  }
  try {
    storage.setItem(key, JSON.stringify(ledger));
  } catch {
    // Quota or private mode: alerts degrade to "every roster looks new after
    // a reload", which is noisier than nothing but never wrong about who is
    // on the roster.
  }
}

export interface JoinAlertFold {
  ledger: JoinAlertLedger;
  /** Pubkeys new since the last fold. Always empty on the seeding fold. */
  joined: string[];
}

/**
 * Fold a roster into the ledger.
 *
 * The first fold *seeds*: everyone present is recorded and nobody is
 * announced, because a user opening the app for the first time has not
 * watched forty people arrive. Later folds announce only pubkeys the ledger
 * has never held.
 */
export function foldRosterIntoLedger(
  ledger: JoinAlertLedger,
  rosterPubkeys: readonly string[],
  viewerPubkey: string | null | undefined,
): JoinAlertFold {
  const viewer = viewerPubkey?.trim().toLowerCase() ?? "";
  const roster = rosterPubkeys
    .map((pubkey) => pubkey.trim().toLowerCase())
    .filter((pubkey) => pubkey.length > 0 && pubkey !== viewer);
  const known = new Set(ledger.pubkeys);
  const joined = ledger.seeded
    ? roster.filter((pubkey) => !known.has(pubkey))
    : [];

  const merged: string[] = [];
  const seen = new Set<string>();
  for (const pubkey of [...ledger.pubkeys, ...roster]) {
    if (seen.has(pubkey)) {
      continue;
    }
    seen.add(pubkey);
    merged.push(pubkey);
  }

  return {
    ledger: { seeded: true, pubkeys: capDeparted(merged, roster) },
    joined,
  };
}

/**
 * Trim only keys that have left the roster, newest-departed first.
 *
 * Dropping a key that is still on the roster would make it alert again on the
 * very next snapshot, so the roster is retained in full regardless of the cap.
 */
function capDeparted(merged: string[], roster: readonly string[]): string[] {
  const onRoster = new Set(roster);
  const departed = merged.filter((pubkey) => !onRoster.has(pubkey));
  if (departed.length <= JOIN_ALERT_DEPARTED_MAX) {
    return merged;
  }
  const keep = new Set(
    departed.slice(departed.length - JOIN_ALERT_DEPARTED_MAX),
  );
  return merged.filter((pubkey) => onRoster.has(pubkey) || keep.has(pubkey));
}
