import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import type { Profile } from "@/features/channels/hooks";
import { openDm } from "@/features/dms/hooks";
import type { RelaySession } from "@/shared/api/relay-session";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/shared/ui/dialog";
import { useObserverStore } from "../../ObserverProvider";
import { findCleanupCandidates } from "../../lib/availableAgents";
import { controlsEnabled } from "../../lib/adminCommandCapabilities";
import type { DesktopCatalog } from "../../lib/desktopCatalog";
import type { RosterRow as AgentRow } from "../../lib/roster";
import type { useAdminCommands } from "../../ui/AgentAdminPanel";
import { SnapshotExportDialog } from "../../ui/SnapshotExportDialog";
import { useTick } from "../../ui/WorkingBadge";
import { agentDesktopReady } from "../agent-screen/agentScreenModel";
import { rosterActionAllowed, type RosterAction } from "../lib/rosterActions";
import {
  buildRosterView,
  filterRoster,
  rosterColumns,
  rosterCounts,
  type RosterFilter,
} from "../lib/rosterView";
import { rosterSnapshot } from "../lib/rosterSnapshot";
import { useRosterActions } from "../lib/useRosterActions";
import { BulkBar } from "./BulkBar";
import { BulkAddChannelDialog } from "./BulkAddChannelDialog";
import { RosterFilters } from "./RosterFilters";
import { RosterRow } from "./RosterRow";
import { RosterRowMenu } from "./RosterRowMenu";

/** W8a read projection: desktop claims never imply running/stopped process state. */
export function RosterTable({
  roster,
  catalogs,
  teamNames,
  profiles,
  admin,
  session,
  onOpen,
}: {
  roster: readonly AgentRow[];
  catalogs: readonly DesktopCatalog[];
  teamNames: ReadonlyMap<string, string[]>;
  profiles: ReadonlyMap<string, Profile>;
  admin: ReturnType<typeof useAdminCommands>;
  session: RelaySession;
  onOpen: (pubkey: string) => void;
}) {
  const observer = useObserverStore();
  const view = buildRosterView(roster, catalogs, teamNames, observer?.byAgent);
  useTick(true);
  const [status, setStatus] = useState<RosterFilter>("All");
  const [team, setTeam] = useState("");
  const [query, setQuery] = useState("");
  const [checked, setChecked] = useState(new Set<string>());
  const [add, setAdd] = useState(false);
  const [unregister, setUnregister] = useState<AgentRow | null>(null);
  const [snapshot, setSnapshot] = useState<AgentRow | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const navigate = useNavigate();
  const actions = useRosterActions(admin);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(entry.contentRect.width),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const visible = filterRoster(view, status, team, query);
  const selected = view.filter((row) => checked.has(row.pubkey));
  const cleanupKeys = new Set(
    findCleanupCandidates(
      roster.map((row) => row.entry),
      catalogs,
    ).map((row) => row.pubkey),
  );
  const allowed = (row: AgentRow, action: RosterAction) =>
    rosterActionAllowed(
      row,
      action,
      cleanupKeys,
      controlsEnabled(catalogs, row.machines),
    ) &&
    (action === "unregister" ||
      agentDesktopReady(catalogs, row.machines, Date.now() / 1000));
  const run = (action: RosterAction, rows: readonly AgentRow[]) => {
    if (rows.length && rows.every((row) => allowed(row, action)))
      void actions.run(action, rows);
  };
  const columns = rosterColumns(width);
  const phone = width < 768;
  const toggle = (pubkey: string) =>
    setChecked((previous) => {
      const next = new Set(previous);
      if (next.has(pubkey)) next.delete(pubkey);
      else next.add(pubkey);
      return next;
    });
  const message = async (row: AgentRow) => {
    try {
      const result = await openDm(session, [row.pubkey]);
      if (!result.ok || !result.channelId)
        throw new Error(result.message || "Could not open the conversation.");
      await navigate({ to: "/repos", search: { c: result.channelId } });
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not open the conversation.",
      );
    }
  };
  const rowNodes = visible.map((row) => (
    <RosterRow
      key={row.pubkey}
      row={row}
      profile={profiles.get(row.pubkey)}
      columns={phone ? ["Agent", "Status", "Model"] : columns}
      selected={checked.has(row.pubkey)}
      disabled={actions.busy}
      onSelect={() => toggle(row.pubkey)}
      onOpen={() => onOpen(row.pubkey)}
      menu={
        <RosterRowMenu
          row={row}
          busy={actions.busy}
          allowed={(action) => allowed(row, action)}
          onAction={(action) =>
            action === "unregister" ? setUnregister(row) : run(action, [row])
          }
          onOpen={() => onOpen(row.pubkey)}
          onMessage={() => void message(row)}
          onExport={() => setSnapshot(row)}
        />
      }
    />
  ));
  return (
    <div ref={ref} className="min-w-0 space-y-4" data-testid="agent-roster">
      {selected.length === 0 ? (
        <RosterFilters
          counts={rosterCounts(view)}
          status={status}
          team={team}
          query={query}
          teams={[...new Set(view.flatMap((row) => row.teams))].sort()}
          onStatus={setStatus}
          onTeam={setTeam}
          onQuery={setQuery}
        />
      ) : null}
      <BulkBar
        selected={selected}
        catalogs={catalogs}
        cleanupKeys={cleanupKeys}
        busy={actions.busy}
        onAction={run}
        onAdd={() => setAdd(true)}
        onClear={() => setChecked(new Set())}
      />
      {actions.busy ? (
        <p role="status" className="text-sm">
          Sending to Buzz Desktop… Waiting for confirmation.
        </p>
      ) : null}
      {actions.receipts.length ? (
        <ul aria-label="Action results" className="space-y-1 text-sm">
          {actions.receipts.map((receipt) => (
            <li
              key={receipt.pubkey}
              className={receipt.ok ? "text-leaf-ink" : "text-coral-ink"}
            >
              {receipt.name}: {receipt.message}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <label className="flex min-h-11 items-center gap-2 border-b border-border px-3 text-xs text-muted-foreground">
          <input
            type="checkbox"
            aria-label="Select all visible agents"
            disabled={actions.busy || !visible.length}
            checked={
              visible.length > 0 &&
              visible.every((row) => checked.has(row.pubkey))
            }
            onChange={(event) => {
              const check = event.target.checked;
              setChecked((previous) => {
                const next = new Set(previous);
                for (const row of visible) {
                  if (check) next.add(row.pubkey);
                  else next.delete(row.pubkey);
                }
                return next;
              });
            }}
            className="h-4 w-4 accent-primary"
          />
          {visible.length} of {view.length} agents
        </label>
        {phone ? (
          <ul data-testid="roster-phone-list" aria-label="Agents">
            {rowNodes}
          </ul>
        ) : (
          <table
            data-testid="roster-table"
            className="w-full table-fixed border-collapse text-left"
          >
            <caption className="sr-only">Your agents</caption>
            <colgroup>
              <col className="w-11" />
              {columns.map((column) => (
                <col
                  key={column}
                  style={
                    column === "Agent"
                      ? { width: "24%" }
                      : column === "Status"
                        ? { width: "22%" }
                        : undefined
                  }
                />
              ))}
              <col className="w-11" />
            </colgroup>
            <thead>
              <tr className="border-b border-border">
                <th aria-label="Selection" />
                {columns.map((column) => (
                  <th
                    scope="col"
                    key={column}
                    className="truncate px-2 py-3 text-2xs font-semibold uppercase tracking-wide text-muted-foreground"
                  >
                    {column}
                  </th>
                ))}
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>{rowNodes}</tbody>
          </table>
        )}
        {!visible.length ? (
          <p className="p-4 text-sm text-muted-foreground">
            {view.length
              ? "No agents match these filters."
              : "No agent registrations yet. Create an agent to get started."}
          </p>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        Claimed means a desktop reports this agent. Working comes from recent
        activity. Model and effort values are read-only here.
      </p>
      {add && selected.length ? (
        <BulkAddChannelDialog
          rows={selected}
          session={session}
          onClose={() => setAdd(false)}
        />
      ) : null}
      {snapshot ? (
        <SnapshotExportDialog
          persona={rosterSnapshot(snapshot, profiles.get(snapshot.pubkey))}
          linkedRows={[snapshot]}
          onClose={() => setSnapshot(null)}
        />
      ) : null}
      <Dialog
        open={unregister !== null}
        onOpenChange={(open) => {
          if (!open) setUnregister(null);
        }}
      >
        <DialogContent>
          <DialogTitle>Unregister {unregister?.name}?</DialogTitle>
          <DialogDescription>
            Remove the stale registration. Its key is kept.
          </DialogDescription>
          <Button
            disabled={
              actions.busy || !unregister || !allowed(unregister, "unregister")
            }
            onClick={() => {
              if (unregister) run("unregister", [unregister]);
              setUnregister(null);
            }}
          >
            Unregister agent
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
