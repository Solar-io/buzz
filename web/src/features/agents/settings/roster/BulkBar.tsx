import { useState } from "react";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/shared/ui/dialog";
import { controlsEnabled } from "../../lib/adminCommandCapabilities";
import type { DesktopCatalog } from "../../lib/desktopCatalog";
import type { RosterRow } from "../../lib/roster";
import { agentDesktopReady } from "../agent-screen/agentScreenModel";
import { rosterActionAllowed, type RosterAction } from "../lib/rosterActions";

export function BulkBar({
  selected,
  catalogs,
  cleanupKeys,
  busy,
  onAction,
  onAdd,
  onClear,
}: {
  selected: readonly RosterRow[];
  catalogs: readonly DesktopCatalog[];
  cleanupKeys: ReadonlySet<string>;
  busy: boolean;
  onAction: (action: RosterAction, rows: readonly RosterRow[]) => void;
  onAdd: () => void;
  onClear: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const unregisterReady = catalogs.some((catalog) =>
    agentDesktopReady(catalogs, [catalog.machine], Date.now() / 1000),
  );
  if (!selected.length) return null;
  return (
    <div className="space-y-2" data-testid="roster-bulk-bar">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-info-line bg-info-soft p-3">
        <span className="mr-1 text-sm font-medium">
          {selected.length} selected
        </span>
        {(["restart", "stop", "start", "unregister"] as const).map((action) => {
          const allowed = selected.every(
            (row) =>
              rosterActionAllowed(
                row,
                action,
                cleanupKeys,
                controlsEnabled(catalogs, row.machines),
              ) &&
              (action === "unregister"
                ? unregisterReady
                : agentDesktopReady(catalogs, row.machines, Date.now() / 1000)),
          );
          return (
            <Button
              key={action}
              className="h-11"
              size="sm"
              variant="outline"
              disabled={busy || !allowed}
              title={
                allowed
                  ? undefined
                  : action === "unregister"
                    ? "Needs a recent desktop report and confirmed stale registration."
                    : "Needs a recent report from a compatible claiming desktop."
              }
              onClick={() =>
                action === "unregister"
                  ? setConfirm(true)
                  : onAction(action, selected)
              }
            >
              {action[0].toUpperCase()}
              {action.slice(1)}
            </Button>
          );
        })}
        <Button
          className="h-11"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={onAdd}
        >
          Add to channel…
        </Button>
        <Button
          className="h-11"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={onClear}
        >
          Clear
        </Button>
      </div>
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogTitle>Unregister {selected.length} agents?</DialogTitle>
          <DialogDescription>
            Remove these stale registrations from the roster. Their keys are
            kept.
          </DialogDescription>
          <ul className="max-h-60 overflow-y-auto text-sm">
            {selected.map((row) => (
              <li key={row.pubkey}>{row.name}</li>
            ))}
          </ul>
          <Button
            disabled={busy || !unregisterReady}
            onClick={() => {
              setConfirm(false);
              onAction("unregister", selected);
            }}
          >
            Unregister agents
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
