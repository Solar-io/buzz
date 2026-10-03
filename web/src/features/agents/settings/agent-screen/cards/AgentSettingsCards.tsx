import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { SaveBar } from "@/shared/ui/settings/SaveBar";
import { durationLabel } from "@/shared/ui/settings/DurationSelect";
import type { RosterRow } from "../../../lib/roster";
import type { DesktopCatalog } from "../../../lib/desktopCatalog";
import { controlsEnabled } from "../../../lib/adminCommandCapabilities";
import type { useAdminCommands } from "../../../ui/AgentAdminPanel";
import { SettingsNavGuard } from "../../ui/SettingsNavGuard";
import { ModelThinkingCard } from "./ModelThinkingCard";
import { RuntimeCard } from "./RuntimeCard";
import { WhoCanInstructCard } from "./WhoCanInstructCard";
import { useAgentCardDraft } from "./useAgentCardDraft";
import { useInstructionPeople } from "./useInstructionPeople";
import type { CardFields } from "./cardTypes";

/** One draft across desktop cards and phone sub-pages, with desktop receipts. */
export function AgentSettingsCards({
  row,
  catalogs,
  admin,
  enabled,
  models,
  roster,
  phone,
  children,
}: {
  row: RosterRow;
  catalogs: DesktopCatalog[];
  admin: ReturnType<typeof useAdminCommands>;
  enabled: boolean;
  models: string[];
  roster: RosterRow[];
  phone: boolean;
  children?: ReactNode;
}) {
  const [page, setPage] = useState<"runtime" | "access" | null>(null);
  const form = useAgentCardDraft(row, admin, enabled);
  const selected: string[] = JSON.parse(
    String(form.value("respondToAllowlist")),
  );
  const people = useInstructionPeople(
    selected,
    roster.map((agent) => agent.pubkey),
  );
  const { draft } = form;
  const fields: CardFields = {
    value: form.value,
    edit: form.edit,
    dirty: (field) => draft.draft.has(`${row.pubkey}:${field}`),
    originalLabel: (field) =>
      draft.draft.get(`${row.pubkey}:${field}`)?.original.label,
    disabled: !enabled || draft.busy || draft.uncertain,
    controlsLocked: !controlsEnabled(catalogs, row.machines),
    machine: row.machines[0] ?? "Buzz Desktop",
  };
  return (
    <div className="min-w-0 space-y-4" data-testid="agent-settings-cards">
      {phone && page && (
        <Button
          variant="ghost"
          className="min-h-11"
          onClick={() => setPage(null)}
        >
          ← Agent settings
        </Button>
      )}
      {(!phone || !page) && (
        <ModelThinkingCard
          row={row}
          fields={fields}
          models={models}
          apiKey={form.apiKey}
          onApiKey={form.onApiKey}
        />
      )}
      {(!phone || page === "runtime") && (
        <RuntimeCard fields={fields} catalogs={catalogs} />
      )}
      {(!phone || page === "access") && (
        <WhoCanInstructCard fields={fields} people={people} />
      )}
      {phone && !page && (
        <section className="rounded-xl border border-border bg-card p-4">
          <h2 className="mb-2 text-xs font-semibold text-muted-foreground">
            More settings
          </h2>
          {(
            [
              ["runtime", "Runtime"],
              ["access", "Who can instruct"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className="flex min-h-11 w-full items-center justify-between border-t border-border text-sm"
              onClick={() => setPage(id)}
            >
              {label}
              <ChevronRight aria-hidden className="size-4" />
            </button>
          ))}
        </section>
      )}
      {(!phone || !page) && children}
      <SaveBar
        summary={draft.summary}
        changes={draft.changes.map((change) => {
          const field = change.id.split(":").pop();
          if (
            field !== "idleTimeoutSeconds" &&
            field !== "maxTurnDurationSeconds"
          )
            return change;
          const entry =
            draft.draft.get(change.id) ??
            draft.receipts
              .flatMap((receipt) => receipt.plan.entries)
              .find(
                (item) => `${item.agentPubkey}:${item.field}` === change.id,
              );
          return entry &&
            entry.change.kind === "set" &&
            typeof entry.change.value === "number"
            ? {
                ...change,
                text: `${entry.agentName} ${entry.label} → ${durationLabel(entry.change.value)}`,
              }
            : change;
        })}
        effectSummary={draft.effectSummary}
        state={draft.state}
        onSave={() => void draft.save()}
        onDiscard={form.discard}
        onUndo={form.canUndo ? () => void draft.undo() : undefined}
        disabled={!enabled}
      />
      <SettingsNavGuard
        count={draft.draft.size}
        screenName={row.name}
        discard={form.discard}
        busy={draft.busy || draft.uncertain}
      />
    </div>
  );
}
