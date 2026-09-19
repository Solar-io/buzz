import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";

import { useElevenVoices, useVoiceCatalog } from "../hooks.ts";
import type { AgentVoiceSelection } from "../lib/agentVoiceSelection.ts";
import { VoiceEngineTabs } from "./VoiceEngineTabs.tsx";
import {
  engineLabel,
  engineVoiceOptions,
  sameOption,
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
                  {option.engine === "pocket" ? "pocket" : "elevenlabs"}
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
 * Pick the speaking voice for the signed-in agent.
 *
 * ENGINE FIRST (Sam, 2026-09-18): a segmented control chooses Pocket or
 * ElevenLabs and the list below shows that engine's voices alone. The
 * browser's own `speechSynthesis` voices are no longer offered at all — see
 * `voicePickerOptions.ts` for why, and `huddlePrefs.ts` for what happens to
 * a kind-30182 row that still names one.
 *
 * Every row previews through its OWN engine via the shared previewer
 * (`voicePreview.ts`), which is real bridge synthesis. Confirming publishes
 * the kind:30182 selection for the logged-in identity; `onConfirm` is async
 * and its error surfaces here, because a relay refusal is the one thing
 * this dialog cannot resolve locally.
 */
export function VoicePickerDialog({
  open,
  onOpenChange,
  current,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  current: AgentVoiceSelection | undefined;
  onConfirm: (selection: AgentVoiceSelection, label: string) => Promise<void>;
}) {
  const { rows, ready: catalogReady } = useVoiceCatalog();
  const { voices: elevenVoices, ready: elevenReady } = useElevenVoices();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Open on the engine the current selection uses, so "which one am I on?"
  // is answered by the control itself rather than by reading the list.
  const [engine, setEngine] = useState<VoiceEngine>(
    current?.engine === "eleven" ? "eleven" : "pocket",
  );
  // The option staged for "Confirm" — clicking Select stages; confirming
  // publishes. Keeps a preview-first flow from publishing as a side effect.
  const [staged, setStaged] = useState<VoicePickerOption | null>(null);

  useEffect(() => {
    if (open) {
      setBusy(false);
      setError(null);
      setStaged(null);
      setEngine(current?.engine === "eleven" ? "eleven" : "pocket");
    }
  }, [open, current?.engine]);

  const options = useMemo(
    () =>
      engineVoiceOptions(engine, {
        catalogRows: rows,
        elevenVoices,
      }),
    [engine, rows, elevenVoices],
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
      await onConfirm(
        staged.engine === "pocket"
          ? { engine: "pocket", key: staged.key }
          : { engine: "eleven", key: staged.key },
        staged.label,
      );
      onOpenChange(false);
    } catch (cause: unknown) {
      setError(
        cause instanceof Error ? cause.message : "Could not save the voice.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-md" data-testid="voice-picker-dialog">
        <DialogHeader>
          <DialogTitle>Choose your agent voice</DialogTitle>
          <DialogDescription>
            Pocket voices are bundled presets; ElevenLabs voices come from the
            community library. Both are synthesized server-side. Preview any of
            them, then confirm to publish your selection.
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
          }}
        />

        <VoicePickerList
          busy={busy}
          current={current}
          engine={engine}
          options={options}
          ready={engine === "pocket" ? catalogReady : elevenReady}
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
