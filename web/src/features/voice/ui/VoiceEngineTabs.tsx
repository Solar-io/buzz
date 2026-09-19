import { cn } from "@/shared/lib/cn";

import {
  VOICE_ENGINES,
  engineLabel,
  type VoiceEngine,
} from "./voicePickerOptions.ts";

/**
 * Engine-first segmented control: Pocket | ElevenLabs.
 *
 * Shared by the Settings picker and the in-huddle settings popover so the
 * two cannot drift into offering different engines — which is exactly what
 * a flat combined list let happen before.
 */
export function VoiceEngineTabs({
  engine,
  onChange,
  disabled = false,
}: {
  engine: VoiceEngine;
  onChange: (engine: VoiceEngine) => void;
  disabled?: boolean;
}) {
  return (
    <div
      aria-label="Voice engine"
      className="flex items-center gap-1 rounded-full border border-border p-0.5"
      data-testid="voice-engine-tabs"
      role="group"
    >
      {VOICE_ENGINES.map((candidate) => {
        const active = candidate === engine;
        return (
          <button
            aria-pressed={active}
            className={cn(
              "flex-1 rounded-full px-3 py-1 text-xs font-medium disabled:opacity-50",
              active
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
            data-testid={`voice-engine-${candidate}`}
            disabled={disabled}
            key={candidate}
            onClick={() => onChange(candidate)}
            type="button"
          >
            {engineLabel(candidate)}
          </button>
        );
      })}
    </div>
  );
}
