/**
 * NIP-56 report (kind:1984) payload builder.
 *
 * The wire contract is pinned by the relay, not by this file:
 * `crates/buzz-relay/src/handlers/report.rs` `parse_report` requires
 * **exactly one** `p` tag (the reported author), **at most one** `e` tag (the
 * reported event), and reads the report *type* from the third element of
 * whichever target tag is present. The member-facing entry point always
 * reports a message, so the `e` tag is always the type carrier here and the
 * `p` tag stays bare — a type on the `p` tag as well would still parse, but
 * the `e` tag wins and the duplicate is dead weight on the wire.
 *
 * Reports are signals, never triggers: the relay queues them to
 * `moderation_reports` and never fans them out or auto-actions (report.rs
 * module docs). Nothing is echoed back to the timeline.
 *
 * Import-free by design so the node test runner can load it directly.
 */

/** `KIND_REPORT` in crates/buzz-core/src/kind.rs — NIP-56. */
export const KIND_REPORT = 1_984;

/**
 * The report vocabulary the relay accepts, verbatim from `REPORT_TYPES` in
 * report.rs. Anything outside this list is rejected at ingest with
 * `invalid: unsupported report type: …`, so the picker may not invent one.
 */
export const REPORT_TYPES = [
  "illegal",
  "nudity",
  "malware",
  "spam",
  "impersonation",
  "profanity",
  "other",
] as const;

export type ReportType = (typeof REPORT_TYPES)[number];

/**
 * Categories in the order shown to the reporter. `other` is last so it reads
 * as the fallback rather than a first-class choice (desktop parity).
 */
export const REPORT_CATEGORIES: ReadonlyArray<{
  value: ReportType;
  label: string;
}> = [
  { value: "spam", label: "Spam" },
  { value: "profanity", label: "Profanity or hate speech" },
  { value: "nudity", label: "Nudity or sexual content" },
  { value: "impersonation", label: "Impersonation" },
  { value: "malware", label: "Malware or scam" },
  { value: "illegal", label: "Illegal content" },
  { value: "other", label: "Other" },
];

/** An unsigned Nostr event template, ready for the shared signer. */
export interface EventTemplate {
  kind: number;
  tags: string[][];
  content: string;
}

const HEX_64 = /^[0-9a-f]{64}$/;

/**
 * Normalize a 64-char hex id/pubkey the way the relay expects it. The relay
 * matches `value.len() == 64 && all ascii hexdigit` (`decode_32_byte_hex`),
 * which accepts mixed case — lowercasing here only keeps our own comparisons
 * honest.
 */
export function normalizeHex32(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!HEX_64.test(normalized)) {
    throw new Error(`Malformed ${label}: expected 64 hex characters.`);
  }
  return normalized;
}

export interface ReportInput {
  /** The reported message's author (the `p` tag target). */
  authorPubkey: string;
  /** The reported message's event id (the `e` tag target). */
  eventId: string;
  reportType: ReportType;
  /** Free-text context from the reporter; becomes the event content. */
  note?: string;
}

/**
 * Build the unsigned kind-1984 event for reporting one message.
 *
 * Throws on a malformed pubkey or event id rather than publishing something
 * the relay will reject with an opaque `invalid:` — the caller has both values
 * from the rendered row, so a failure here is a programming error, not user
 * input.
 */
export function buildReportEvent(input: ReportInput): EventTemplate {
  if (!REPORT_TYPES.includes(input.reportType)) {
    throw new Error(`Unsupported report type: ${String(input.reportType)}`);
  }
  const note = input.note?.trim() ?? "";
  return {
    kind: KIND_REPORT,
    tags: [
      ["p", normalizeHex32(input.authorPubkey, "author pubkey")],
      ["e", normalizeHex32(input.eventId, "event id"), input.reportType],
    ],
    content: note,
  };
}
