/**
 * Identity archive settings card.
 *
 * Archival is deliberately non-silent (NIP-IA §Self Requests): the point of
 * the design is that an archived identity can SEE that it is archived and undo
 * it. So the first thing this card shows is your own state — not a moderation
 * console with your own row buried in it.
 */

import { useEffect, useState } from "react";
import { Archive, ArchiveRestore, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { ownPubkey } from "@/shared/lib/nostr-signer";
import { cn } from "@/shared/lib/cn";
import { truncatePubkey } from "@/shared/lib/pubkey";

import { ARCHIVE_REASONS } from "../lib/identityArchiveEvents.ts";
import { useArchivedIdentities, useIdentityArchive } from "../hooks";

const selectClass = cn(
  "h-9 rounded-md border border-input bg-background px-2 text-sm",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
);

/** Self row: your own archived state, and the self-service undo. */
function SelfSection() {
  const [self, setSelf] = useState<string | null>(null);
  useEffect(() => {
    void ownPubkey().then(setSelf);
  }, []);
  const actions = useIdentityArchive(self);

  if (!self) {
    return (
      <p className="text-sm text-muted-foreground/70">
        Unlock a key to see your archive status.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">
          You{" "}
          {actions.isArchived === undefined ? (
            <Badge variant="outline">checking…</Badge>
          ) : actions.isArchived ? (
            <Badge variant="warning">Archived</Badge>
          ) : (
            <Badge variant="success">Active</Badge>
          )}
        </p>
        <p className="font-mono text-xs text-muted-foreground">
          {truncatePubkey(self)}
        </p>
      </div>
      {actions.isArchived === true ? (
        <Button
          disabled={actions.isPending}
          onClick={() => {
            void actions.unarchive().then((error) => {
              if (error) toast.error(`Unarchive failed: ${error}`);
              else toast.success("Unarchived on this relay");
            });
          }}
          size="sm"
        >
          <ArchiveRestore className="mr-1 h-3.5 w-3.5" />
          Unarchive me
        </Button>
      ) : actions.isArchived === false ? (
        <Button
          disabled={actions.isPending}
          onClick={() => {
            if (
              !window.confirm(
                "Archive your own identity on this relay? You stay able to see and undo this from here.",
              )
            ) {
              return;
            }
            void actions.archive({ reason: "retired" }).then((error) => {
              if (error) toast.error(`Archive failed: ${error}`);
              else toast.success("Archived on this relay");
            });
          }}
          size="sm"
          variant="outline"
        >
          <Archive className="mr-1 h-3.5 w-3.5" />
          Archive me
        </Button>
      ) : null}
    </div>
  );
}

/** Archive or unarchive another identity — gated by the relay on submit. */
function TargetSection() {
  const [target, setTarget] = useState("");
  const [reason, setReason] = useState<string>("rotated");
  const [replacedBy, setReplacedBy] = useState("");
  const actions = useIdentityArchive(target.trim() || null);

  const valid = /^[0-9a-f]{64}$/i.test(target.trim());

  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <p className="text-sm font-medium">Archive another identity</p>
      <p className="text-xs text-muted-foreground">
        Allowed for a relay owner or admin, or for the verified NIP-OA owner of
        an agent key. The relay checks again when the request arrives.
      </p>
      <Input
        aria-label="Target pubkey (hex)"
        className="font-mono text-xs"
        onChange={(event) => setTarget(event.target.value)}
        placeholder="target pubkey (64 hex)"
        value={target}
      />
      <div className="flex flex-wrap gap-2">
        <select
          aria-label="Reason"
          className={selectClass}
          onChange={(event) => setReason(event.target.value)}
          value={reason}
        >
          {ARCHIVE_REASONS.map((entry) => (
            <option key={entry} value={entry}>
              {entry}
            </option>
          ))}
        </select>
        <Input
          aria-label="Replaced by (optional)"
          className="max-w-64 font-mono text-xs"
          onChange={(event) => setReplacedBy(event.target.value)}
          placeholder="replaced-by pubkey (optional)"
          value={replacedBy}
        />
      </div>
      {valid && !actions.canArchive ? (
        <p className="text-xs text-muted-foreground/70">
          You do not hold a consent path for this identity, so the relay would
          refuse the request.
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button
          disabled={!valid || !actions.canArchive || actions.isPending}
          onClick={() => {
            void actions
              .archive({
                reason,
                ...(replacedBy.trim() ? { replacedBy: replacedBy.trim() } : {}),
              })
              .then((error) => {
                if (error) toast.error(`Archive failed: ${error}`);
                else toast.success("Archived on this relay");
              });
          }}
          size="sm"
        >
          Archive
        </Button>
        <Button
          disabled={!valid || !actions.canArchive || actions.isPending}
          onClick={() => {
            void actions.unarchive({ reason }).then((error) => {
              if (error) toast.error(`Unarchive failed: ${error}`);
              else toast.success("Unarchived on this relay");
            });
          }}
          size="sm"
          variant="outline"
        >
          Unarchive
        </Button>
      </div>
    </div>
  );
}

export function IdentityArchiveCard() {
  const { archived, loading, refresh, unavailable } = useArchivedIdentities();

  return (
    <section
      className="space-y-3 rounded-lg border border-border bg-card p-4"
      data-testid="identity-archive-card"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-medium">Identity archive</h2>
        <Button onClick={refresh} size="sm" variant="ghost">
          <RefreshCw className="mr-1 h-3.5 w-3.5" />
          Refresh
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Archiving retires a key on this relay without deleting its history.
        Archived identities drop out of forward-looking places — mention
        autocomplete, the DM picker, member lists — but never from your own view
        of yourself.
      </p>

      {unavailable ? (
        <p className="text-sm text-muted-foreground/70">
          This relay does not advertise its own signing key, so archive state
          cannot be verified here. Nothing is treated as archived.
        </p>
      ) : (
        <>
          <SelfSection />
          <TargetSection />
          <div>
            <p className="text-sm font-medium">
              Archived on this relay{" "}
              <span className="text-muted-foreground">
                ({loading ? "…" : archived.length})
              </span>
            </p>
            {loading ? null : archived.length === 0 ? (
              <p className="text-sm text-muted-foreground/70">
                Nobody is archived.
              </p>
            ) : (
              <ul className="mt-1 space-y-0.5">
                {archived.map((pubkey) => (
                  <li
                    className="font-mono text-xs text-muted-foreground"
                    key={pubkey}
                    title={pubkey}
                  >
                    {truncatePubkey(pubkey)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}
