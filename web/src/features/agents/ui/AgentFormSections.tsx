import { useId, useState } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { HarnessSelect } from "./HarnessSelect";
import { EnvVarsTable } from "./EnvVarsTable";
import type { DesktopCatalog } from "../lib/desktopCatalog";
import type { EnvRow } from "../lib/envRows";
import { modelSuggestions } from "../lib/modelSuggestions";
import {
  RESPOND_TO_OPTIONS,
  accessWarning,
  type RespondToMode,
} from "../lib/respondToField";

/**
 * Shared presentational form sections, used by BOTH the create form and the
 * edit panel so the two surfaces cannot drift. Each section is controlled
 * and self-contained: it renders controls and warnings, never builds
 * commands (that lives in createAgentRequest.ts / editAgentRequest.ts).
 *
 * Copy rule (desktop AGENTS.md #11/#13): plain language only, no protocol
 * jargon in primary copy, the access warning names the consequence where the
 * audience is selected, and nothing renders a value the web cannot know.
 */

function newRowId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `row-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}

/** Section heading — the desktop's section rhythm, web density. */
export function SectionHeading({ children }: { children: string }) {
  return (
    <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </h3>
  );
}

export function IdentityFields({
  name,
  onNameChange,
  systemPrompt,
  onSystemPromptChange,
  promptDisabled = false,
  promptNote,
  avatarUrl,
  onAvatarUrlChange,
}: {
  name: string;
  onNameChange: (next: string) => void;
  systemPrompt: string;
  onSystemPromptChange: (next: string) => void;
  /** Definition-linked agents: the prompt is definition-owned (edit mode). */
  promptDisabled?: boolean;
  promptNote?: string;
  /** Create-only: the update path drops avatarUrl (protocol limit). */
  avatarUrl?: string;
  onAvatarUrlChange?: (next: string) => void;
}) {
  return (
    <div className="space-y-3">
      <SectionHeading>Identity</SectionHeading>
      <div className="block space-y-1">
        <span className="block text-sm text-muted-foreground">Name</span>
        <Input
          aria-label="Name"
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
          placeholder="e.g. Night Shift"
        />
      </div>
      <label className="block space-y-1">
        <span className="text-sm text-muted-foreground">System prompt</span>
        <textarea
          aria-label="System prompt"
          value={systemPrompt}
          onChange={(event) => onSystemPromptChange(event.target.value)}
          rows={5}
          disabled={promptDisabled}
          className="w-full resize-y rounded-md border border-input bg-card px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
          placeholder="What this agent does day to day…"
        />
      </label>
      {promptNote && (
        <p className="rounded-md bg-accent/40 px-2 py-1 text-xs text-muted-foreground">
          {promptNote}
        </p>
      )}
      {onAvatarUrlChange && (
        <div className="block space-y-1">
          <span className="block text-sm text-muted-foreground">
            Avatar URL
          </span>
          <Input
            aria-label="Avatar URL"
            value={avatarUrl ?? ""}
            onChange={(event) => onAvatarUrlChange(event.target.value)}
            placeholder="https://… (create-only — the desktop dialog edits it later)"
          />
        </div>
      )}
    </div>
  );
}

export function ModelProviderFields({
  model,
  onModelChange,
  provider,
  onProviderChange,
  registryModels,
  quadDisabled = false,
  quadNote,
  harnessId,
  onHarnessChange,
  customCommand,
  onCustomCommandChange,
  customArgs,
  onCustomArgsChange,
  catalogs,
  harnessKeep,
}: {
  model: string;
  onModelChange: (next: string) => void;
  provider: string;
  onProviderChange: (next: string) => void;
  /** Models observed in the owner's 30177 registry (suggestion union). */
  registryModels: string[];
  /** Definition-linked agents: model/provider are definition-owned. */
  quadDisabled?: boolean;
  quadNote?: string;
  harnessId: string;
  onHarnessChange: (next: string) => void;
  customCommand: string;
  onCustomCommandChange: (next: string) => void;
  customArgs: string;
  onCustomArgsChange: (next: string) => void;
  catalogs: DesktopCatalog[];
  /** Edit mode prepends "Keep current" to the harness list. */
  harnessKeep?: boolean;
}) {
  const listId = useId();
  const models = modelSuggestions(provider, registryModels);
  return (
    <div className="space-y-3">
      <SectionHeading>Model &amp; provider</SectionHeading>
      <datalist id={listId}>
        {models.map((suggestion) => (
          <option key={suggestion} value={suggestion} />
        ))}
      </datalist>
      <div className="flex gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <span className="block text-sm text-muted-foreground">Model</span>
          <Input
            aria-label="Model"
            value={model}
            onChange={(event) => onModelChange(event.target.value)}
            placeholder="e.g. glm-5.3"
            disabled={quadDisabled}
            list={listId}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <span className="block text-sm text-muted-foreground">Provider</span>
          <Input
            aria-label="Provider"
            value={provider}
            onChange={(event) => onProviderChange(event.target.value)}
            placeholder="e.g. zai"
            disabled={quadDisabled}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>
      </div>
      {quadNote && (
        <p className="rounded-md bg-accent/40 px-2 py-1 text-xs text-muted-foreground">
          {quadNote}
        </p>
      )}
      <HarnessSelect
        value={harnessId}
        onChange={onHarnessChange}
        catalogs={catalogs}
        ariaLabel="Harness"
        includeKeep={harnessKeep}
      />
      {harnessId === "__custom" && (
        <div className="flex gap-2">
          <div className="min-w-0 flex-1 space-y-1">
            <span className="block text-sm text-muted-foreground">Command</span>
            <Input
              aria-label="Command"
              value={customCommand}
              onChange={(event) => onCustomCommandChange(event.target.value)}
              placeholder="bun run seat.ts"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </div>
          <div className="min-w-0 flex-1 space-y-1">
            <span className="block text-sm text-muted-foreground">Args</span>
            <Input
              aria-label="Args"
              value={customArgs}
              onChange={(event) => onCustomArgsChange(event.target.value)}
              placeholder="--a --b"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </div>
        </div>
      )}
    </div>
  );
}

export function RuntimeFields({
  parallelism,
  onParallelismChange,
}: {
  parallelism: string;
  onParallelismChange: (next: string) => void;
}) {
  return (
    <div className="space-y-3">
      <SectionHeading>Runtime</SectionHeading>
      <div className="block space-y-1">
        <span className="block text-sm text-muted-foreground">
          Parallelism (worker count)
        </span>
        <Input
          aria-label="Parallelism"
          value={parallelism}
          onChange={(event) => onParallelismChange(event.target.value)}
          placeholder="e.g. 3"
          inputMode="numeric"
          className="max-w-28"
        />
        <span className="block text-xs text-muted-foreground">
          How many turns this agent may run at once. Blank keeps the current
          value.
        </span>
      </div>
    </div>
  );
}

/**
 * Who can send instructions: mode select + access warning + the pubkey row
 * editor for "Specific people". The warning renders directly below the
 * select for "Anyone" but AFTER the people picker for "Specific people"
 * (desktop rule: never between the user and the selection they came to
 * make).
 */
export function AccessFields({
  respondTo,
  onRespondToChange,
  allowlist,
  onAllowlistChange,
}: {
  respondTo: RespondToMode;
  onRespondToChange: (next: RespondToMode) => void;
  allowlist: string[];
  onAllowlistChange: (next: string[]) => void;
}) {
  // Rows are internal so a mid-list removal never re-keys (and thus never
  // steals focus from) the surviving inputs; remounting the section resets.
  const [rows, setRows] = useState(() =>
    allowlist.map((value) => ({ id: newRowId(), value })),
  );
  const emit = (next: { id: string; value: string }[]) => {
    setRows(next);
    onAllowlistChange(next.map((row) => row.value.trim()).filter(Boolean));
  };
  const warning = accessWarning(respondTo);
  return (
    <div className="space-y-3">
      <SectionHeading>Access</SectionHeading>
      <label className="block space-y-1">
        <span className="text-sm text-muted-foreground">
          Who can send instructions
        </span>
        <select
          value={respondTo}
          onChange={(event) =>
            onRespondToChange(event.target.value as RespondToMode)
          }
          className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
          aria-label="Who can send instructions"
        >
          {RESPOND_TO_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      {respondTo === "anyone" && warning && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-500">
          {warning}
        </p>
      )}
      {respondTo === "allowlist" && (
        <>
          <div className="space-y-1.5">
            {rows.length === 0 && (
              <p className="rounded-md bg-accent/30 px-2 py-1.5 text-xs text-muted-foreground">
                No keys yet — add the agent keys that may use this agent.
              </p>
            )}
            {rows.map((row, index) => (
              <div key={row.id} className="flex items-center gap-1.5">
                <Input
                  aria-label={`Allowed key ${index + 1}`}
                  value={row.value}
                  onChange={(event) =>
                    emit(
                      rows.map((candidate) =>
                        candidate.id === row.id
                          ? { ...candidate, value: event.target.value }
                          : candidate,
                      ),
                    )
                  }
                  placeholder="64-hex agent key"
                  className="font-mono text-xs"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove allowed key ${index + 1}`}
                  className="shrink-0"
                  onClick={() =>
                    emit(rows.filter((candidate) => candidate.id !== row.id))
                  }
                >
                  <X aria-hidden className="h-4 w-4" />
                </Button>
              </div>
            ))}
            <Button
              size="sm"
              variant="outline"
              onClick={() => emit([...rows, { id: newRowId(), value: "" }])}
            >
              <Plus aria-hidden className="mr-1 h-4 w-4" />
              Add key
            </Button>
          </div>
          {warning && (
            <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-500">
              {warning}
            </p>
          )}
        </>
      )}
    </div>
  );
}

export function EnvFields({
  rows,
  onChange,
  dirty,
  editMode,
}: {
  rows: EnvRow[];
  onChange: (next: EnvRow[]) => void;
  dirty: boolean;
  editMode: boolean;
}) {
  return (
    <div className="space-y-3">
      <SectionHeading>Environment</SectionHeading>
      <EnvVarsTable
        rows={rows}
        onChange={onChange}
        dirty={dirty}
        editMode={editMode}
      />
    </div>
  );
}
