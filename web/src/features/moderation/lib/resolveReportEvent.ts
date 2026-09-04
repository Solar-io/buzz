/**
 * "Resolve report" payload builder — the last kind of the moderation-command
 * range (9040-9044), whose integer is `KIND_MODERATION_RESOLVE_REPORT` in
 * `crates/buzz-core/src/kind.rs`.
 *
 * Tag vocabulary is pinned by `moderation_commands.rs::handle_resolve` and
 * quoted here so a drift shows up as a diff rather than a runtime `invalid:`:
 *
 * - exactly one `["report", <report event id hex>]` — the signed kind-1984
 *   event id, NOT the `moderation_reports` row id. The relay looks the row up
 *   with `get_moderation_report_by_event` under its own tenant.
 * - exactly one `["status", "resolved" | "dismissed"]`.
 * - exactly one `["action", delete|kick|ban|timeout|dismiss|escalate]`, where
 *   `dismiss` pairs only with `dismissed` and everything else with `resolved`.
 * - optional `["reason", <text>]` — audited into
 *   `moderation_actions.public_reason` AND relayed verbatim in the DM the
 *   relay sends the reporter, so it must be safe for the reporter to read.
 *   (`private_reason` is mod-only and is not fed by these tags at all.)
 *
 * A resolve carries **no `h` tag**: it is a community-global direct command,
 * and `is_global_only_kind` rejects a stray `h` as channel-scoping a global
 * one.
 *
 * What a resolve does NOT do is enforce anything. It records the decision,
 * closes the report row, and DMs the reporter "reviewed and acted on". The
 * paired 9005/9001/9040/9042 is the client's job and has to land FIRST, or the
 * reporter is told an action happened that did not.
 *
 * Its only imports are `reportEvent.ts` and `queueAuthority.ts`, both
 * import-light with extensioned relative paths, so the node test runner can
 * load this module directly.
 */

import type { EventTemplate } from "./reportEvent.ts";
import { normalizeHex32 } from "./reportEvent.ts";
import type { ResolutionAction } from "./queueAuthority.ts";
import { statusForAction } from "./queueAuthority.ts";

/** `KIND_MODERATION_RESOLVE_REPORT` in crates/buzz-core/src/kind.rs. */
export const KIND_MODERATION_RESOLVE_REPORT = 9_044;

export interface ResolveReportInput {
  /** The kind-1984 event id being resolved. */
  reportEventId: string;
  action: ResolutionAction;
  /** Moderator note. Reporter-readable — see the module doc. */
  reason?: string;
}

/**
 * Build the unsigned resolve event.
 *
 * The status is derived from the action rather than accepted as a parameter:
 * the relay enforces the pairing, and a caller that could pass both could pass
 * a mismatched pair.
 */
export function buildResolveReportEvent(
  input: ResolveReportInput,
): EventTemplate {
  const tags: string[][] = [
    ["report", normalizeHex32(input.reportEventId, "report event id")],
    ["status", statusForAction(input.action)],
    ["action", input.action],
  ];
  const reason = input.reason?.trim();
  if (reason) {
    tags.push(["reason", reason]);
  }
  return {
    kind: KIND_MODERATION_RESOLVE_REPORT,
    tags,
    content: "",
  };
}
