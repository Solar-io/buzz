import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/shared/ui/button";
import { Switch } from "@/shared/ui/switch";
import type { RelaySession } from "@/shared/api/relay-session";
import { ownPubkey, type SignedNostrEvent } from "@/shared/lib/nostr-signer";
import {
  buildCoordinateDelete,
  buildShareToggle,
  deleteBlockers,
  isSharedEvent,
} from "../lib/definitionManage";
import type { PersonaDefinition } from "../lib/personas";
import type { RosterRow } from "../lib/roster";
import type { TeamView } from "../lib/teamEvents";
import { SectionHeading } from "./AgentFormSections";
import { publishSigned } from "./publishSigned";
import { SnapshotExportDialog } from "./SnapshotExportDialog";

/**
 * Share / delete / export controls under the standalone definition editor.
 * Every publish goes from `base` (the newer of the relay head and our own
 * last publish) and requires the signer to be the definition's author.
 * Delete publishes the desktop-identical a-tag tombstone and REFUSES while
 * any agent or team still uses the definition (deleteBlockers) — desktop's
 * inbound tombstone does not cascade, so deleting under live agents would
 * orphan them.
 */
export function DefinitionActions({
  persona,
  base,
  onPublished,
  roster,
  teams,
  session,
  onDeleted,
}: {
  persona: PersonaDefinition;
  base: SignedNostrEvent;
  onPublished: (event: SignedNostrEvent) => void;
  roster: readonly RosterRow[];
  teams: ReadonlyMap<string, TeamView>;
  session: RelaySession;
  /** Called with the tombstone's created_at after an accepted delete. */
  onDeleted: (tombstoneCreatedAt: number) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [exporting, setExporting] = useState(false);
  const shared = isSharedEvent(base);
  const blocker = deleteBlockers(persona.id, persona.name, roster, teams);
  const linked = roster.filter((row) => row.entry.personaId === persona.id);

  const ownerCheck = async (): Promise<string | null> => {
    const me = await ownPubkey();
    return me === base.pubkey ? me : null;
  };

  const toggleShare = async (next: boolean) => {
    if (busy) {
      return;
    }
    if (!(await ownerCheck())) {
      toast.error("Only the definition's owner can change sharing.");
      return;
    }
    const built = buildShareToggle(base, next, Math.floor(Date.now() / 1000));
    if ("error" in built) {
      toast.error(built.error);
      return;
    }
    setBusy(true);
    const result = await publishSigned(
      session,
      built.template,
      "The relay rejected the definition.",
    );
    setBusy(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    onPublished(result.signed);
    toast.success(
      next
        ? `Published ${persona.name} to the community catalog.`
        : `${persona.name} is no longer discoverable in the community catalog.`,
    );
  };

  const remove = async () => {
    if (busy || blocker) {
      return;
    }
    const me = await ownerCheck();
    if (!me) {
      toast.error("Only the definition's owner can delete it.");
      return;
    }
    const built = buildCoordinateDelete(
      30175,
      me,
      persona.id,
      base.created_at,
      Math.floor(Date.now() / 1000),
    );
    if ("error" in built) {
      toast.error(built.error);
      return;
    }
    setBusy(true);
    const result = await publishSigned(
      session,
      built.template,
      "The relay rejected the deletion.",
    );
    setBusy(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    setConfirming(false);
    toast.success(`Deleted ${persona.name}`);
    onDeleted(built.template.created_at);
  };

  return (
    <div className="space-y-3">
      <SectionHeading>Manage</SectionHeading>
      <div className="flex items-center gap-2 text-sm">
        <Switch
          checked={shared}
          disabled={busy}
          onCheckedChange={(next) => void toggleShare(next)}
          aria-label="Share to catalog"
        />
        <span aria-hidden>Share to catalog</span>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => setExporting(true)}>
          Export snapshot…
        </Button>
        {confirming ? (
          <>
            <Button
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() => void remove()}
            >
              Confirm delete
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={busy || blocker !== null}
            onClick={() => setConfirming(true)}
          >
            Delete definition
          </Button>
        )}
      </div>
      {blocker && (
        <p
          className="text-xs text-muted-foreground"
          data-testid="web-definition-delete-blocker"
        >
          {blocker}
        </p>
      )}
      {exporting && (
        <SnapshotExportDialog
          persona={{ ...persona, event: base }}
          linkedRows={linked}
          onClose={() => setExporting(false)}
        />
      )}
    </div>
  );
}
