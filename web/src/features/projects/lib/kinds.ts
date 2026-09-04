/**
 * Event kinds for the projects surface.
 *
 * These mirror `crates/buzz-core/src/kind.rs` — the relay is the authority for
 * every integer here, and the web client copies rather than imports (web and
 * desktop are deliberately decoupled; nothing crosses the boundary but the
 * wire format).
 *
 * - NIP-34 git kinds: repo announcement/state, patch, PR, issue, statuses.
 * - NIP-MP (`docs/nips/NIP-MP.md`): kind:30621 multi-repo project.
 * - NIP-09 deletion (kind:5) tombstones an addressable coordinate.
 *
 * All of these are *global-only* kinds at the relay: `is_global_only_kind`
 * (crates/buzz-relay/src/handlers/ingest.rs) lists every one of them, so they
 * are never channel-scoped and a stray `h` tag does not route them. Live
 * fan-out therefore goes through the relay's global (kind) index, and a
 * subscription must NOT carry `#h` for them.
 */

/** NIP-01 text note — used for issue comments (the relay does not register NIP-22 kind:1111). */
export const KIND_TEXT_NOTE = 1;
/** NIP-09 deletion request. */
export const KIND_DELETION = 5;
/** NIP-34 issue. */
export const KIND_GIT_ISSUE = 1621;
/** NIP-34 status — Open. */
export const KIND_GIT_STATUS_OPEN = 1630;
/** NIP-34 status — Applied / Merged / Resolved. */
export const KIND_GIT_STATUS_MERGED = 1631;
/** NIP-34 status — Closed. */
export const KIND_GIT_STATUS_CLOSED = 1632;
/** NIP-34 status — Draft. */
export const KIND_GIT_STATUS_DRAFT = 1633;
/** NIP-34 repository announcement (parameterized replaceable, `d` = repo id). */
export const KIND_REPO_ANNOUNCEMENT = 30617;
/** NIP-MP multi-repo project (parameterized replaceable, `d` = project slug). */
export const KIND_PROJECT_ANNOUNCEMENT = 30621;

/** Every NIP-34 lifecycle status kind, in the order the relay declares them. */
export const GIT_STATUS_KINDS = [
  KIND_GIT_STATUS_OPEN,
  KIND_GIT_STATUS_MERGED,
  KIND_GIT_STATUS_CLOSED,
  KIND_GIT_STATUS_DRAFT,
] as const;
