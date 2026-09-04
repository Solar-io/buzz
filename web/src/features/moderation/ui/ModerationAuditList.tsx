import { truncatePubkey } from "@/shared/lib/pubkey";
import type { ModerationAuditAction } from "../lib/queueRows.ts";

/**
 * The community's moderation audit log (`GET /moderation/audit`).
 *
 * Two vocabularies land in the same list and the difference matters when
 * reading it: a `resolve:*` row is a moderator's *decision* about a report,
 * while the unprefixed row of the same name (`ban`, `delete`) is the
 * *enforcement* that carried it out. The relay writes both on purpose so audit
 * consumers do not double-count — `moderation_commands.rs` calls that out —
 * so the label below keeps the prefix rather than tidying it away.
 */
export function ModerationAuditList({
  actions,
  loading,
  error,
  nameOf,
}: {
  actions: readonly ModerationAuditAction[];
  loading: boolean;
  error: string | null;
  /** Display name for a pubkey, or a truncation of it. */
  nameOf: (pubkey: string) => string;
}) {
  if (error) {
    return (
      <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        {error}
      </p>
    );
  }
  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading audit log…</p>;
  }
  if (actions.length === 0) {
    return (
      <p
        className="rounded-lg border border-dashed border-border/70 bg-background/40 px-3 py-6 text-center text-sm text-muted-foreground"
        data-testid="moderation-audit-empty"
      >
        No moderation actions yet.
      </p>
    );
  }
  return (
    <div className="space-y-2" data-testid="moderation-audit-list">
      {actions.map((action) => {
        const target = action.targetPubkey ?? action.targetEventId ?? null;
        return (
          <div
            className="space-y-1 rounded-lg border border-border/60 bg-card/60 px-3 py-2"
            data-testid={`moderation-audit-${action.id}`}
            key={action.id}
          >
            <div className="flex flex-wrap items-center gap-1.5 text-sm">
              <span className="font-medium">
                {action.action.replace(/_/g, " ")}
              </span>
              {target ? (
                <span className="font-mono text-xs text-muted-foreground">
                  → {truncatePubkey(target)}
                </span>
              ) : null}
              <span className="text-xs text-muted-foreground">
                by {nameOf(action.actorPubkey)} ·{" "}
                {new Date(action.createdAt).toLocaleString(undefined, {
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </span>
            </div>
            {action.publicReason ? (
              <p className="text-xs text-muted-foreground/80">
                {action.publicReason}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
