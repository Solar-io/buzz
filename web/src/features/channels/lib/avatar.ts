/**
 * Avatar fallback rules, ported from `desktop/src/shared/ui/UserAvatar.tsx`
 * and `desktop/src/shared/lib/initials.ts`.
 *
 * The web client previously took `label.slice(0, 2)` (so "Sam Gallant" read
 * "SA" and "@alice" read "@A") and drew a continuous `hsl(hue, 45%, 42%)`
 * hash, which produced muddy near-identical colors for neighbouring names.
 * Both are replaced here by the desktop's rules: real word initials, and a
 * fixed seven-class palette whose entries were chosen to be distinguishable
 * from one another in both themes.
 */

/** Derive up to two uppercase initials from a display name. */
export function getInitials(name: string): string {
  return name
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .trim()
    .split(/\s+/)
    .map((part) => part[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

/**
 * The desktop's seven identicon classes, in its order. Each pairs a fill with
 * a foreground that clears contrast on it — amber and cyan are light enough
 * to need dark text.
 */
export const AVATAR_PALETTE = [
  "bg-blue-500 text-white",
  "bg-emerald-500 text-white",
  "bg-amber-400 text-amber-950",
  "bg-rose-500 text-white",
  "bg-cyan-400 text-cyan-950",
  "bg-violet-500 text-white",
  "bg-orange-500 text-white",
] as const;

/**
 * Pick one palette entry for a display name. Same hash as the desktop
 * (FNV-ish 31 multiply over code points, unsigned), so a person carries the
 * same color in both clients.
 */
export function avatarPaletteClass(displayName: string): string {
  const hash = Array.from(displayName.trim().toLowerCase()).reduce(
    (value, character) => (value * 31 + (character.codePointAt(0) ?? 0)) >>> 0,
    0,
  );
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
}
