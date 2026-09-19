import { Settings } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useElevenVoices, useVoiceCatalog } from "@/features/voice/hooks.ts";
import { VoiceEngineTabs } from "@/features/voice/ui/VoiceEngineTabs.tsx";
import {
  engineLabel,
  engineVoiceOptions,
  type VoiceEngine,
} from "@/features/voice/ui/voicePickerOptions.ts";
import { createVoicePreviewer } from "@/features/voice/ui/voicePreview.ts";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";

import type { HuddleDuplexMode, HuddlePrefs } from "../lib/huddlePrefs.ts";

/**
 * The gear: this channel's voice and its duplex discipline.
 *
 * PER CHANNEL, on purpose. The Settings picker publishes the voice an AGENT
 * speaks with everywhere; this overrides it for one DM or channel in this
 * browser only (Sam, 2026-09-18: "the voice chosen in Settings is the
 * default; a per-DM / per-channel override must be settable from inside the
 * huddle"). "Use default (Settings)" is therefore not a reset button so
 * much as the normal state — it clears the override and lets the published
 * selection through again.
 *
 * Engine-first, sharing `VoiceEngineTabs` and the bridge previewer with the
 * Settings dialog rather than carrying a second copy of either.
 */
export function HuddleSettingsPopover({
  prefs,
  onChange,
  disabled = false,
}: {
  prefs: HuddlePrefs;
  onChange: (prefs: HuddlePrefs) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [engine, setEngine] = useState<VoiceEngine>(
    prefs.voice?.engine ?? "pocket",
  );
  const { rows, ready: catalogReady } = useVoiceCatalog();
  const { voices: elevenVoices, ready: elevenReady } = useElevenVoices();
  const previewerRef = useRef(createVoicePreviewer());

  useEffect(() => {
    const previewer = previewerRef.current;
    return () => previewer.dispose();
  }, []);
  useEffect(() => {
    if (open) {
      setEngine(prefs.voice?.engine ?? "pocket");
    }
  }, [open, prefs.voice?.engine]);

  const options = useMemo(
    () => engineVoiceOptions(engine, { catalogRows: rows, elevenVoices }),
    [engine, rows, elevenVoices],
  );
  const ready = engine === "pocket" ? catalogReady : elevenReady;

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <button
          aria-label="Huddle settings"
          className="rounded-full border border-border px-2 py-1 text-muted-foreground hover:text-foreground disabled:opacity-50"
          data-testid="huddle-settings"
          disabled={disabled}
          title="Voice and duplex settings for this channel"
          type="button"
        >
          <Settings aria-hidden className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-3" side="top">
        <section className="space-y-2">
          <h3 className="text-xs font-medium">Voice in this channel</h3>
          <VoiceEngineTabs engine={engine} onChange={setEngine} />
          <ul
            className="flex max-h-48 flex-col gap-0.5 overflow-y-auto"
            data-testid="huddle-voice-list"
          >
            {options.length === 0 ? (
              <li className="py-3 text-center text-2xs text-muted-foreground">
                {ready
                  ? `No ${engineLabel(engine)} voices are available from the bridge.`
                  : "Loading voices…"}
              </li>
            ) : (
              options.map((option) => {
                const selected =
                  prefs.voice?.engine === option.engine &&
                  prefs.voice.key === option.key;
                return (
                  <li
                    className="flex items-center gap-1"
                    data-testid="huddle-voice-row"
                    key={option.key}
                  >
                    <span className="min-w-0 flex-1 truncate text-xs">
                      {option.label}
                    </span>
                    <Button
                      data-testid="huddle-voice-preview"
                      onClick={() =>
                        previewerRef.current.preview({
                          engine: option.engine,
                          key: option.key,
                        })
                      }
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      Preview
                    </Button>
                    <Button
                      data-testid="huddle-voice-select"
                      onClick={() =>
                        onChange({
                          ...prefs,
                          voice: { engine: option.engine, key: option.key },
                        })
                      }
                      size="sm"
                      type="button"
                      variant={selected ? "secondary" : "ghost"}
                    >
                      {selected ? "Using" : "Use"}
                    </Button>
                  </li>
                );
              })
            )}
          </ul>
          <Button
            className="w-full"
            data-testid="huddle-voice-default"
            disabled={prefs.voice === null}
            onClick={() => onChange({ ...prefs, voice: null })}
            size="sm"
            type="button"
            variant="ghost"
          >
            Use default (Settings)
          </Button>
        </section>

        <section
          aria-label="Duplex mode"
          className="space-y-2 border-t border-border pt-3"
        >
          <h3 className="text-xs font-medium">While the agent speaks</h3>
          <div className="flex flex-col gap-1" data-testid="huddle-duplex">
            {[
              {
                mode: "half" as HuddleDuplexMode,
                title: "Half-duplex",
                note: "Your mic is paused until she finishes.",
              },
              {
                mode: "barge" as HuddleDuplexMode,
                title: "Barge-in",
                note: "Your mic stays live; speaking cuts her off.",
              },
            ].map((choice) => {
              const active = prefs.duplex === choice.mode;
              return (
                <button
                  aria-pressed={active}
                  className={cn(
                    "rounded-md border px-2 py-1.5 text-left",
                    active
                      ? "border-emerald-600/50 bg-emerald-600/10"
                      : "border-border hover:bg-accent",
                  )}
                  data-testid={`huddle-duplex-${choice.mode}`}
                  key={choice.mode}
                  onClick={() => onChange({ ...prefs, duplex: choice.mode })}
                  type="button"
                >
                  <span className="block text-xs font-medium">
                    {choice.title}
                  </span>
                  <span className="block text-2xs text-muted-foreground">
                    {choice.note}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      </PopoverContent>
    </Popover>
  );
}
