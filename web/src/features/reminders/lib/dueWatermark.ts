/**
 * The fire-on-due watermark: the last instant this device checked for due
 * reminders. Everything at or before it has already had its chance to alert.
 *
 * Per-device and per-key, in `localStorage`, because it is a property of "has
 * this browser already told you" — not of the reminder, which is shared
 * across devices. Two devices each alert once, which is the desktop's
 * behaviour too and is what a user expects from a reminder.
 */

const STORAGE_PREFIX = "buzz:lastReminderCheck:";

/** The `Storage` surface this module needs — injectable for tests. */
export interface WatermarkStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function watermarkStorageKey(pubkey: string): string {
  return `${STORAGE_PREFIX}${pubkey.trim().toLowerCase()}`;
}

/**
 * Read the watermark, seeding it to `now` when this device has never checked.
 *
 * Seeding to `now` rather than 0 is the difference between a working feature
 * and an alarm storm: with a 0 seed, the first check on a new device finds
 * every reminder the user has ever set already "newly due" and fires the lot.
 * A reminder that is already overdue at first launch therefore never toasts —
 * it shows in the panel and the badge, which is where history belongs.
 *
 * A stored value that is not a finite number (hand-edited, or written by an
 * older build) is treated as absent and re-seeded, rather than becoming `NaN`
 * — every comparison against NaN is false, which would silently disable
 * firing forever.
 */
export function readWatermark(
  storage: WatermarkStorage,
  pubkey: string,
  now: number,
): number {
  const key = watermarkStorageKey(pubkey);
  const stored = storage.getItem(key);
  if (stored !== null) {
    const parsed = Number(stored);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  storage.setItem(key, String(now));
  return now;
}

/** Advance the watermark. */
export function writeWatermark(
  storage: WatermarkStorage,
  pubkey: string,
  now: number,
): void {
  storage.setItem(watermarkStorageKey(pubkey), String(now));
}
