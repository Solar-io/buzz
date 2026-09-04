/**
 * The unread count in `document.title`, so a backgrounded tab shows activity
 * in the tab strip without the OS notification permission.
 *
 * Applying the badge is a read-modify-write on a string the app also owns, so
 * the formatter has to be idempotent: strip any badge already present before
 * adding one, or a second arrival produces `(2) (1) Buzz`.
 */

/** Counts above this render as `99+` rather than growing the tab label. */
export const TITLE_BADGE_MAX = 99;

/** Matches a badge this module produced, at the head of a title. */
const BADGE_PREFIX = /^\(\d+\+?\)\s+/;

/** Remove a leading badge, leaving the app's own title. */
export function stripTitleBadge(title: string): string {
  return title.replace(BADGE_PREFIX, "");
}

/**
 * Render `count` unread onto `baseTitle`.
 *
 * A zero, negative, or non-finite count yields the bare title — the caller
 * clears the badge by passing 0 rather than by remembering to call something
 * else.
 */
export function formatTitleBadge(baseTitle: string, count: number): string {
  const base = stripTitleBadge(baseTitle);
  if (!Number.isFinite(count) || count <= 0) {
    return base;
  }
  const whole = Math.floor(count);
  const shown = whole > TITLE_BADGE_MAX ? `${TITLE_BADGE_MAX}+` : String(whole);
  return `(${shown}) ${base}`;
}
