import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import { truncatePubkey } from "../../../shared/lib/pubkey.ts";
import type { ExportBounds, ExportStopReason } from "./exportPlan.ts";
import { describeStopReason } from "./exportPlan.ts";

/**
 * Serialisation for a channel export.
 *
 * Two formats, because they answer different questions:
 *
 * - **JSON** keeps every signed event exactly as the relay served it — `id`,
 *   `pubkey`, `sig` and all tags. That file can be re-verified against the
 *   Nostr signature scheme years later, replayed into another relay, or
 *   diffed. It is the archival artefact.
 * - **Markdown** is a transcript a person can read without any tooling. It
 *   is lossy on purpose (signatures, tags and raw ids are summarised away),
 *   so it is offered alongside the JSON, never instead of it.
 */

export type ExportFormat = "json" | "markdown";

/** Everything both writers need beyond the events themselves. */
export interface ExportContext {
  channelId: string;
  channelName: string;
  relayUrl: string;
  /** Unix seconds. */
  exportedAt: number;
  kinds: number[];
  bounds: ExportBounds;
  reason: ExportStopReason;
  /** Pages where every event shared one timestamp — see `PagePlan`. */
  sameTimestampPages: number;
}

/** Kinds whose `content` is human prose worth rendering as a transcript line. */
const PROSE_KINDS = new Set([9, 40002, 45001, 45003]);

export function isProseKind(kind: number): boolean {
  return PROSE_KINDS.has(kind);
}

function isoSeconds(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

/** `YYYY-MM-DD` in UTC — the transcript's day heading. */
export function utcDay(unixSeconds: number): string {
  return isoSeconds(unixSeconds).slice(0, 10);
}

/** `HH:MM:SS` in UTC — timestamps stay UTC so a file reads the same anywhere. */
export function utcTime(unixSeconds: number): string {
  return isoSeconds(unixSeconds).slice(11, 19);
}

/**
 * Filename-safe slug for a channel name. Diacritics and emoji collapse to
 * separators rather than being smuggled into a filename the OS may mangle.
 */
export function slugifyChannelName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "channel";
}

/**
 * `buzz-<channel>-<YYYY-MM-DD>.<ext>`.
 *
 * The date is the export date in UTC, so two exports on the same day
 * overwrite rather than accumulating near-duplicates in a downloads folder.
 */
export function archiveFileName(
  channelName: string,
  exportedAt: number,
  format: ExportFormat,
): string {
  const extension = format === "json" ? "json" : "md";
  return `buzz-${slugifyChannelName(channelName)}-${utcDay(exportedAt)}.${extension}`;
}

/** MIME type for the Blob a format is written into. */
export function archiveMimeType(format: ExportFormat): string {
  return format === "json"
    ? "application/json;charset=utf-8"
    : "text/markdown;charset=utf-8";
}

/** The archive envelope, above the raw events. Versioned for future readers. */
export interface ArchiveJson {
  buzzArchiveVersion: 1;
  channel: { id: string; name: string };
  relay: string;
  exportedAt: string;
  kinds: number[];
  eventCount: number;
  /** False when a ceiling or a cancel cut the walk short. */
  complete: boolean;
  completeness: string;
  /** Present only when at least one page was timestamp-saturated. */
  warnings?: string[];
  events: SignedNostrEvent[];
}

function warningsFor(context: ExportContext): string[] {
  if (context.sameTimestampPages <= 0) {
    return [];
  }
  return [
    `${context.sameTimestampPages} page(s) came back full with every event sharing one timestamp; events past the page size at those exact seconds were unreachable.`,
  ];
}

/** Build the archive envelope. Split out from stringify so tests can assert it. */
export function buildArchiveJson(
  events: SignedNostrEvent[],
  context: ExportContext,
): ArchiveJson {
  const warnings = warningsFor(context);
  const archive: ArchiveJson = {
    buzzArchiveVersion: 1,
    channel: { id: context.channelId, name: context.channelName },
    relay: context.relayUrl,
    exportedAt: isoSeconds(context.exportedAt),
    kinds: [...context.kinds].sort((a, b) => a - b),
    eventCount: events.length,
    complete: context.reason === "complete",
    completeness: describeStopReason(context.reason, context.bounds),
    events,
  };
  if (warnings.length > 0) {
    archive.warnings = warnings;
  }
  return archive;
}

export function serializeArchiveJson(
  events: SignedNostrEvent[],
  context: ExportContext,
): string {
  return `${JSON.stringify(buildArchiveJson(events, context), null, 2)}\n`;
}

/** Author label for the transcript: a resolved name, else a short pubkey. */
export function authorLabel(
  pubkey: string,
  displayNames: ReadonlyMap<string, string>,
): string {
  const name = displayNames.get(pubkey);
  return name && name.trim().length > 0 ? name : truncatePubkey(pubkey);
}

/**
 * One transcript entry.
 *
 * Prose kinds render their content verbatim under an author heading.
 * Everything else (reactions, edits, deletions, system rows) renders as a
 * one-line note that names the kind — dropping them silently would make the
 * transcript disagree with the JSON about what the channel contains.
 */
export function transcriptEntry(
  event: SignedNostrEvent,
  displayNames: ReadonlyMap<string, string>,
): string {
  const who = authorLabel(event.pubkey, displayNames);
  const time = utcTime(event.created_at);
  if (!isProseKind(event.kind)) {
    const summary = event.content.replace(/\s+/g, " ").trim().slice(0, 120);
    const tail = summary.length > 0 ? ` — ${summary}` : "";
    return `_${time} · ${who} · kind ${event.kind}${tail}_`;
  }
  const body = event.content.length > 0 ? event.content : "_(empty message)_";
  return `**${time} · ${who}**\n\n${body}`;
}

/**
 * Render the whole transcript.
 *
 * Content is written verbatim — a message that happens to contain Markdown
 * renders as Markdown. That is the right trade for a *readable* transcript;
 * the JSON export is the one that guarantees byte fidelity.
 */
export function serializeTranscriptMarkdown(
  events: SignedNostrEvent[],
  context: ExportContext,
  displayNames: ReadonlyMap<string, string> = new Map(),
): string {
  const lines: string[] = [
    `# ${context.channelName}`,
    "",
    `- Channel id: \`${context.channelId}\``,
    `- Relay: ${context.relayUrl}`,
    `- Exported: ${isoSeconds(context.exportedAt)}`,
    `- Events: ${events.length} (kinds ${[...context.kinds].sort((a, b) => a - b).join(", ")})`,
    `- Completeness: ${describeStopReason(context.reason, context.bounds)}`,
  ];
  for (const warning of warningsFor(context)) {
    lines.push(`- Warning: ${warning}`);
  }
  lines.push("", "All times are UTC.", "");

  let day: string | null = null;
  for (const event of events) {
    const eventDay = utcDay(event.created_at);
    if (eventDay !== day) {
      day = eventDay;
      lines.push("---", "", `## ${eventDay}`, "");
    }
    lines.push(transcriptEntry(event, displayNames), "");
  }
  return `${lines.join("\n")}`;
}

/** Serialise to whichever format was chosen. */
export function serializeArchive(
  format: ExportFormat,
  events: SignedNostrEvent[],
  context: ExportContext,
  displayNames?: ReadonlyMap<string, string>,
): string {
  return format === "json"
    ? serializeArchiveJson(events, context)
    : serializeTranscriptMarkdown(events, context, displayNames);
}
