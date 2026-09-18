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
import {
  playBridgeResponse,
  ttsBridgeUrl,
} from "../../huddle/lib/bridgeSpeech.ts";
import {
  elevenVoiceOptions,
  localVoiceOptions,
  pocketVoiceOptions,
  PREVIEW_SAMPLE_TEXT,
  sameOption,
  speakPreview,
  type PickerVoiceLike,
  type VoicePickerOption,
} from "./voicePickerOptions.ts";

/**
 * The picker body, deliberately presentational: fixture rows and fake voices
 * in the test drive exactly what production feeds it.
 */
export function VoicePickerList({
  options,
  current,
  onPreview,
  onSelect,
  busy,
  pocketReady,
}: {
  options: VoicePickerOption[];
  current: AgentVoiceSelection | undefined;
  onPreview: (option: VoicePickerOption) => void;
  onSelect: (option: VoicePickerOption) => void;
  busy: boolean;
  pocketReady: boolean;
}) {
  if (options.length === 0) {
    return (
      <p className="py-4 text-center text-sm text-muted-foreground">
        {pocketReady
          ? "No English voices available — the catalog is empty and this system has no English speechSynthesis voices."
          : "Loading voices…"}
      </p>
    );
  }
  return (
    <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
      {options.map((option) => {
        const selected = sameOption(option, current);
        return (
          <li
            key={`${option.engine}:${option.key ?? option.voiceURI}`}
          >
            <div
              className="flex w-full items-center gap-2 rounded-md px-2 py-1 hover:bg-accent"
              data-testid="voice-picker-row"
            >
              <span className="min-w-0 flex-1 truncate text-left text-sm">
                {option.label}
                <span className="ml-2 shrink-0 text-2xs text-muted-foreground">
                  {option.engine === "pocket"
                    ? "pocket"
                    : option.engine === "eleven"
                      ? "elevenlabs"
                      : "on-device"}
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
 * Lists both engines — kind:30181 catalog rows (pocket, synthesized
 * server-side) and this machine's English `speechSynthesis` voices — each
 * with a Preview button that speaks a sample line through the engine it
 * names. Confirming publishes the kind:30182 selection for the logged-in
 * identity; `onConfirm` is async and its error surfaces here, because a
 * relay refusal is the one thing this dialog cannot resolve locally.
 */
export function VoicePickerDialog({
  open,
  onOpenChange,
  current,
  localVoices,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  current: AgentVoiceSelection | undefined;
  /** `speechSynthesis.getVoices()` output — ranked or raw, both fine. */
  localVoices: readonly PickerVoiceLike[];
  onConfirm: (selection: AgentVoiceSelection, label: string) => Promise<void>;
}) {
  const { rows, ready } = useVoiceCatalog();
  const { voices: elevenVoices } = useElevenVoices();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The option staged for "Confirm" — clicking Select stages; confirming
  // publishes. Keeps a preview-first flow from publishing as a side effect.
  const [staged, setStaged] = useState<VoicePickerOption | null>(null);

  useEffect(() => {
    if (open) {
      setBusy(false);
      setError(null);
      setStaged(null);
    }
  }, [open]);

  const options = useMemo(
    () => [
      ...pocketVoiceOptions(rows),
      ...elevenVoiceOptions(elevenVoices),
      ...localVoiceOptions(localVoices),
    ],
    [rows, elevenVoices, localVoices],
  );

  // One lazily-created AudioContext for bridge previews — created inside a
  // click handler, which is the user gesture browsers require.
  const previewCtxRef = useRef<AudioContext | null>(null);

  function preview(option: VoicePickerOption) {
    if (typeof window === "undefined") {
      return;
    }
    // Bridge engines preview through the REAL synthesis path — the silent
    // stub era ended with the bridge.
    if (option.engine === "pocket" || option.engine === "eleven") {
      const voice =
        option.engine === "pocket" ? option.key.slice("pocket:".length) : option.key.slice("eleven:".length);
      if (previewCtxRef.current === null) {
        try {
          previewCtxRef.current = new AudioContext({ sampleRate: 24_000 });
        } catch {
          previewCtxRef.current = new AudioContext();
        }
      }
      void previewCtxRef.current.resume?.();
      void (async () => {
        try {
          const res = await fetch(ttsBridgeUrl(window.location.hostname), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              engine: option.engine,
              voice,
              text: PREVIEW_SAMPLE_TEXT,
            }),
          });
          if (!res.ok) {
            return;
          }
          await playBridgeResponse(res, previewCtxRef.current!);
        } catch {
          // A failed preview must never wedge the dialog.
        }
      })();
      return;
    }
    if (!window.speechSynthesis) {
      return;
    }
    speakPreview(option, {
      cancel: () => window.speechSynthesis.cancel(),
      speak: (utterance) => {
        // The real utterance construction lives here, behind the same
        // surface the tests stub: one place, one shape.
        const spoken = new SpeechSynthesisUtterance(utterance.text);
        const voice = window.speechSynthesis
          .getVoices()
          .find((candidate) => candidate.voiceURI === utterance.voiceURI);
        if (voice) {
          spoken.voice = voice;
        }
        spoken.lang = utterance.lang;
        window.speechSynthesis.speak(spoken);
      },
    });
  }

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
          : staged.engine === "eleven"
            ? { engine: "eleven", key: staged.key }
            : { engine: "local-synth", voiceURI: staged.voiceURI },
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
            Catalog voices are synthesized server-side; on-device voices come
            from this browser. Preview any of them, then confirm to publish your
            selection.
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

        <VoicePickerList
          busy={busy}
          current={current}
          options={options}
          pocketReady={ready}
          onPreview={preview}
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
