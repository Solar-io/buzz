import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";

import { useChatterboxVoices, useBridgeVoices } from "../hooks.ts";
import type { AgentVoiceSelection } from "../lib/agentVoiceSelection.ts";
import type { VoicePickerTarget } from "../lib/chatterboxRoster.ts";
import { VoiceEngineTabs } from "./VoiceEngineTabs.tsx";
import {
  FILTER_THRESHOLD,
  engineLabel,
  engineVoiceOptions,
  filterVoiceOptions,
  initialEngine,
  sameOption,
  withCurrentPinned,
  type VoiceEngine,
  type VoicePickerOption,
} from "./voicePickerOptions.ts";
import { createVoicePreviewer } from "./voicePreview.ts";

/**
 * The picker body, deliberately presentational: fixture rows and fixture
 * bridge voices in the test drive exactly what production feeds it.
 */
export function VoicePickerList({
  options,
  current,
  onPreview,
  onSelect,
  busy,
  ready,
  engine,
}: {
  options: VoicePickerOption[];
  current: AgentVoiceSelection | undefined;
  onPreview: (option: VoicePickerOption) => void;
  onSelect: (option: VoicePickerOption) => void;
  busy: boolean;
  /** Has the source for this engine finished loading? */
  ready: boolean;
  engine: VoiceEngine;
}) {
  if (options.length === 0) {
    return (
      <p className="py-4 text-center text-sm text-muted-foreground">
        {ready
          ? `No ${engineLabel(engine)} voices are available from the bridge.`
          : "Loading voices…"}
      </p>
    );
  }
  return (
    <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
      {options.map((option) => {
        const selected = sameOption(option, current);
        return (
          <li key={`${option.engine}:${option.key}`}>
            <div
              className="flex w-full items-center gap-2 rounded-md px-2 py-1 hover:bg-accent"
              data-testid="voice-picker-row"
            >
              <span className="min-w-0 flex-1 truncate text-left text-sm">
                {option.label}
                <span className="ml-2 shrink-0 text-2xs text-muted-foreground">
                  {option.detail ?? engineLabel(option.engine).toLowerCase()}
                </span>
              </span>
              <Button
                data-testid="voice-picker-preview"
                disabled={busy}
                onClick={() => onPreview(option)}
                size="sm"
                type="button"
                variant="ghost"
              >
                Preview
              </Button>
              <Button
                data-testid="voice-picker-select"
                disabled={busy}
                onClick={() => onSelect(option)}
                size="sm"
                type="button"
                variant={selected ? "secondary" : "ghost"}
              >
                {selected ? "Selected" : "Select"}
              </Button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Pick a speaking voice — for the signed-in identity (`mode="self"`, the
 * "Your voice" card, publishes kind 30182) or for one of the owner's agents
 * (`mode="assign"`, the "Agent voices" card and the profile card, publishes
 * the owner-signed kind 30183). The dialog itself never publishes: the
 * caller's `onConfirm` decides which kind, so assign mode cannot reach the
 * 30182 publisher by construction.
 *
 * ENGINE FIRST: a segmented control chooses Chatterbox, ElevenLabs or Fish Audio and the
 * list shows that engine's voices alone, with a filter box once the list
 * outgrows a glance. Reserved voices (Evie's) appear only when assigning to
 * the agent they belong to (`chatterboxRoster.ts isVoiceOfferedFor`).
 *
 * Every row previews through its OWN engine via the shared previewer
 * (`voicePreview.ts`), which is real bridge synthesis. `onConfirm` is async
 * and its error surfaces here, because a relay refusal is the one thing
 * this dialog cannot resolve locally.
 */
export function VoicePickerDialog({
  open,
  onOpenChange,
  current,
  currentLabel,
  onConfirm,
  mode = "self",
  target = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  current: AgentVoiceSelection | undefined;
  currentLabel?: string;
  onConfirm: (selection: AgentVoiceSelection, label: string) => Promise<void>;
  mode?: "self" | "assign";
  /** The agent being assigned a voice (assign mode). */
  target?: VoicePickerTarget | null;
}) {
  const { voices: chatterboxVoices, ready: chatterboxReady } =
    useChatterboxVoices();
  const { voices: elevenVoices, ready: elevenReady } =
    useBridgeVoices("eleven");
  const { voices: fishVoices, ready: fishReady } = useBridgeVoices("fish");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // Open on the engine the current selection uses, so "which one am I on?"
  // is answered by the control itself rather than by reading the list.
  const [engine, setEngine] = useState<VoiceEngine>(initialEngine(current));
  // The option staged for "Confirm" — clicking Select stages; confirming
  // publishes. Keeps a preview-first flow from publishing as a side effect.
  const [staged, setStaged] = useState<VoicePickerOption | null>(null);

  const currentEngine = current?.engine;
  useEffect(() => {
    if (open) {
      setBusy(false);
      setError(null);
      setStaged(null);
      setQuery("");
      setEngine(
        initialEngine(currentEngine ? { engine: currentEngine } : null),
      );
    }
  }, [open, currentEngine]);

  const assignTarget = mode === "assign" ? target : null;
  const allOptions = useMemo(
    () =>
      engineVoiceOptions(engine, {
        chatterboxVoices,
        elevenVoices,
        fishVoices,
        target: assignTarget,
      }),
    [engine, chatterboxVoices, elevenVoices, fishVoices, assignTarget],
  );
  const options = useMemo(
    () =>
      withCurrentPinned(
        filterVoiceOptions(allOptions, query),
        (engine === "fish"
          ? fishReady
          : engine === "eleven"
            ? elevenReady
            : false) &&
          current?.engine === engine &&
          !allOptions.some((row) => sameOption(row, current))
          ? current
          : undefined,
        currentLabel,
      ),
    [allOptions, query, engine, fishReady, elevenReady, current, currentLabel],
  );

  // One previewer for the dialog's lifetime; its AudioContext is built on
  // the first Preview click, which is the gesture browsers require.
  const previewerRef = useRef(createVoicePreviewer());
  useEffect(() => {
    const previewer = previewerRef.current;
    return () => previewer.dispose();
  }, []);

  async function confirm() {
    if (staged === null || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onConfirm({ engine: staged.engine, key: staged.key }, staged.label);
      onOpenChange(false);
    } catch (cause: unknown) {
      setError(
        cause instanceof Error ? cause.message : "Could not save the voice.",
      );
    } finally {
      setBusy(false);
    }
  }

  const title =
    mode === "assign" && target
      ? `Choose ${target.name}'s voice`
      : "Choose your voice";

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-md" data-testid="voice-picker-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {mode === "assign"
              ? "As this agent's owner, your choice is what every listener hears. Preview any voice, then confirm."
              : "Binds your own signed-in identity. Chatterbox voices run locally; ElevenLabs and Fish Audio voices come from the community library. Preview any of them, then confirm."}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <p
            className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400"
            role="alert"
          >
            {error}
          </p>
        )}

        <VoiceEngineTabs
          engine={engine}
          onChange={(next) => {
            setEngine(next);
            setStaged(null);
            setQuery("");
          }}
        />

        {allOptions.length > FILTER_THRESHOLD && (
          <input
            aria-label="Filter voices"
            className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
            data-testid="voice-picker-filter"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter voices"
            type="search"
            value={query}
          />
        )}

        <VoicePickerList
          busy={busy}
          current={current}
          engine={engine}
          options={options}
          ready={
            engine === "chatterbox"
              ? chatterboxReady
              : engine === "fish"
                ? fishReady
                : elevenReady
          }
          onPreview={(option) =>
            previewerRef.current.preview({
              engine: option.engine,
              key: option.key,
            })
          }
          onSelect={(option) => setStaged(option)}
        />

        <div className="flex justify-end gap-2">
          <Button
            data-testid="voice-picker-cancel"
            disabled={busy}
            onClick={() => onOpenChange(false)}
            size="sm"
            type="button"
            variant="ghost"
          >
            Cancel
          </Button>
          <Button
            data-testid="voice-picker-confirm"
            disabled={busy || staged === null}
            onClick={() => void confirm()}
            size="sm"
            type="button"
            variant="secondary"
          >
            {staged === null
              ? "Confirm"
              : busy
                ? "Publishing…"
                : `Confirm ${staged.label}`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
