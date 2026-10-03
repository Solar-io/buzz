import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { SaveBar } from "@/shared/ui/settings/SaveBar";
import { cardChangeText } from "./cardChangeText";
import type { RosterRow } from "../../../lib/roster";
import type { DesktopCatalog } from "../../../lib/desktopCatalog";
import { controlsEnabled } from "../../../lib/adminCommandCapabilities";
import type { useAdminCommands } from "../../../ui/useAdminCommands";
import { SettingsNavGuard } from "../../ui/SettingsNavGuard";
import { ModelThinkingCard } from "./ModelThinkingCard";
import { RuntimeCard } from "./RuntimeCard";
import { WhoCanInstructCard } from "./WhoCanInstructCard";
import { IdentityCard } from "./IdentityCard";
import { EnvVarsCard } from "./EnvVarsCard";
import { RemoveCard } from "./RemoveCard";
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
  avatarUrl,
  channelCount,
  onRemoved,
  requestedRemove,
  onRemoveHandled,
}: {
  row: RosterRow;
  catalogs: DesktopCatalog[];
  admin: ReturnType<typeof useAdminCommands>;
  enabled: boolean;
  models: string[];
  roster: RosterRow[];
  phone: boolean;
  children?: ReactNode;
  avatarUrl?: string;
  channelCount: number;
  onRemoved: () => void;
  requestedRemove?: "delete" | "unregister" | null;
  onRemoveHandled?: () => void;
}) {
  const [page, setPage] = useState<
    "runtime" | "access" | "identity" | "environment" | "remove" | null
  >(null);
  const extendedEnabled = controlsEnabled(catalogs, row.machines);
  const form = useAgentCardDraft(
    row,
    admin,
    enabled,
    extendedEnabled,
    avatarUrl,
  );
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
    controlsLocked: !extendedEnabled,
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
      {(!phone || page === "identity") && (
        <IdentityCard row={row} fields={fields} />
      )}
      {(!phone || page === "environment") && (
        <EnvVarsCard
          rows={form.envRows}
          onChange={form.onEnvRows}
          disabled={fields.disabled || fields.controlsLocked}
        />
      )}
      <RemoveCard
        row={row}
        admin={admin}
        channelCount={channelCount}
        disabled={fields.disabled || draft.draft.size > 0}
        onRemoved={onRemoved}
        hidden={phone && page !== "remove"}
        requestedAction={requestedRemove}
        onRequestHandled={onRemoveHandled}
      />
      {phone && !page && (
        <section className="rounded-xl border border-border bg-card p-4">
          <h2 className="mb-2 text-xs font-semibold text-muted-foreground">
            More settings
          </h2>
          {(
            [
              ["runtime", "Runtime"],
              ["access", "Who can instruct"],
              ["identity", "Identity"],
              ["environment", "Environment variables"],
              ["remove", "Remove agent"],
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
          const entry =
            draft.draft.get(change.id) ??
            draft.receipts
              .flatMap((receipt) => receipt.plan.entries)
              .find(
                (item) => `${item.agentPubkey}:${item.field}` === change.id,
              );
          return entry
            ? { ...change, text: cardChangeText(entry, people) }
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
