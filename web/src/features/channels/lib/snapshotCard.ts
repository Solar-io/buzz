import type { ImetaEntry } from "./imetaEntries.ts";

/**
 * Snapshot-card candidate classification — byte-for-byte port of
 * `desktop/src/shared/ui/markdownFileCard.ts` (`resolveSnapshotCard` +
 * `snapshotDisplayName`). Pure and import-free of React so the node runner
 * can load this file.
 *
 * Two deliberate deltas, both noted inline: the sha256 gate also requires hex
 * (stronger than the desktop's length-only check), and `thumb` is the raw href
 * because web media goes through the signed fetch instead of the desktop's
 * `rewriteRelayUrl` host rewrite.
 */

export type ResolvedSnapshotCard = {
  /** Sender-provided display label, with a filename-derived fallback. */
  displayName: string;
  href: string;
  filename: string;
  size?: number;
  /** SHA-256 hex from the imeta `x` field — required for verified fetch. */
  sha256: string;
  /** Discriminant for the snapshot kind. */
  snapshotKind: "agent" | "team";
  /**
   * Optional thumbnail URL for the card icon. PNG snapshots use the
   * attachment URL because the PNG body is the avatar card image. JSON
   * snapshots have no thumbnail and use the generic icon.
   */
  thumb?: string;
};

function snapshotDisplayName(filename: string, childText: string): string {
  const label = childText.trim();
  const labelIsSnapshotFilename = /\.agent\.(?:json|png)$/i.test(label);
  if (label && !labelIsSnapshotFilename) {
    return label;
  }

  const filenameStem = filename
    .replace(/\.agent\.(?:json|png)$/i, "")
    .replace(/[-_]+/g, " ")
    .trim();
  if (!filenameStem) {
    return "Agent";
  }

  return filenameStem
    .split(/\s+/)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

const SIXTY_FOUR_HEX = /^[0-9a-fA-F]{64}$/;

/**
 * Classify a markdown link as a snapshot candidate.
 *
 * A link is a candidate when (desktop rules, verbatim):
 * - The filename ends with `.agent.json`, `.agent.png`, `.team.json`, or
 *   `.team.png` (exact suffix, case-insensitive, after extracting from the
 *   URL if imeta has no filename).
 * - For the PNG suffixes, the MIME must be `image/png` or absent (upload MIME
 *   is authoritative only for PNG because generic JSON often arrives as
 *   `application/octet-stream`).
 * - The imeta entry carries an `x` (SHA-256) field — required for the bounded
 *   verified fetch.
 *
 * Returns `null` to fall through to normal link handling.
 *
 * DELTA from the desktop: `x` must also be 64 HEX characters, not merely 64
 * long. The desktop checks length only; a 64-char non-hex value can never
 * survive the post-fetch hash comparison, so rendering an import card whose
 * verification is doomed would be dishonest UI — such links fall through to a
 * plain link here instead. (The desktop's fetch path enforces hex at command
 * time with "invalid expected sha256 — must be a 64-hex-digit lowercase
 * string", so this matches the desktop's eventual behavior, earlier.)
 */
export function resolveSnapshotCard(
  entry: ImetaEntry | undefined,
  href: string | undefined,
  childText: string,
): ResolvedSnapshotCard | null {
  if (!href || !entry) {
    return null;
  }

  const filename =
    entry.filename || childText.trim() || (href.split("/").pop() ?? "");

  if (!filename) {
    return null;
  }

  const lower = filename.toLowerCase();
  const isJson = lower.endsWith(".agent.json");
  const isPng = lower.endsWith(".agent.png");
  const isTeamJson = lower.endsWith(".team.json");
  const isTeamPng = lower.endsWith(".team.png");

  if (!isJson && !isPng && !isTeamJson && !isTeamPng) {
    return null;
  }

  const isAnyPng = isPng || isTeamPng;

  // For PNG: MIME must be image/png when present; other MIMEs are inconsistent.
  if (isAnyPng && entry.m && entry.m !== "image/png") {
    return null;
  }

  // SHA-256 is required for the bounded verified fetch.
  const sha256 = entry.x?.trim();
  if (sha256 === undefined || !SIXTY_FOUR_HEX.test(sha256)) {
    return null;
  }

  const snapshotKind: "agent" | "team" = isJson || isPng ? "agent" : "team";

  return {
    displayName: snapshotDisplayName(filename, childText),
    href,
    filename,
    size: entry.size,
    sha256: sha256.toLowerCase(),
    snapshotKind,
    // Agent PNG snapshots carry the avatar card image. Team PNG snapshots use
    // a transport placeholder, so the team icon renders instead of that image.
    // Web delta: the raw href — the signed fetch supplies the relay auth the
    // desktop gets from rewriteRelayUrl's host mapping.
    thumb: isPng ? href : undefined,
  };
}
