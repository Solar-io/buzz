/** Durable replay receipts, scoped to the signing owner and applying machine. */
export interface OwnerAdminReplayStore {
  claim(requestId: string, expiresAt: number, now: number): boolean;
}

/**
 * Use WebKit's persistent localStorage, outside the disposable snapshot cache
 * prefixes in localStorageQuota.ts. Read on each claim: a remount/restart or
 * discarded in-memory cache must never forget a still-fresh command. Claim
 * synchronously before any async save; storage failure must refuse the write.
 */
export function ownerAdminReplayStore(
  storage: Pick<Storage, "getItem" | "setItem">,
  owner: string,
  machine: string,
): OwnerAdminReplayStore {
  const key = `buzz-owner-admin-replay.v1:${JSON.stringify([owner, machine])}`;
  return {
    claim(requestId, expiresAt, now) {
      const raw = storage.getItem(key);
      const entries: unknown = raw === null ? [] : JSON.parse(raw);
      if (
        !Array.isArray(entries) ||
        entries.some(
          (entry) =>
            !Array.isArray(entry) ||
            entry.length !== 2 ||
            typeof entry[0] !== "string" ||
            typeof entry[1] !== "number" ||
            !Number.isFinite(entry[1]),
        )
      ) {
        throw new Error("Invalid owner-admin replay receipts.");
      }
      const live = (entries as [string, number][]).filter(
        ([, expiry]) => expiry >= now,
      );
      if (live.some(([id]) => id === requestId)) return false;
      // Never evict a live receipt to admit another command. Older receipts
      // can expire only once freshness already rejects their mutation.
      if (live.length >= 4096) {
        throw new Error(
          "Owner-admin replay receipts are full. Try again later.",
        );
      }
      storage.setItem(key, JSON.stringify([...live, [requestId, expiresAt]]));
      return true;
    },
  };
}
