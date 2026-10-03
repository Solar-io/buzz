import { Button } from "@/shared/ui/button";
import type {
  AvailableVoice,
  LibraryEngine,
  LibraryVoice,
} from "../lib/voiceLibraryModel.ts";
import { sortVoiceOptions } from "./voicePickerOptions.ts";

/** Curated and browse rows share the pickers' exact ordering and engine keys. */
export function VoiceLibraryRows({
  engine,
  voices,
  browse = false,
  isAdmin,
  busy,
  onPreview,
  onAdd,
  onRemove,
}: {
  engine: LibraryEngine;
  voices: readonly (LibraryVoice | AvailableVoice)[];
  browse?: boolean;
  isAdmin: boolean;
  busy: boolean;
  onPreview: (key: string) => void;
  onAdd: (id: string) => void;
  onRemove: (voice: LibraryVoice) => void;
}) {
  const options = sortVoiceOptions(
    voices.map((voice) => ({ ...voice, key: `${engine}:${voice.id}` })),
  );
  return (
    <ul
      className="max-h-64 space-y-1 overflow-y-auto"
      data-testid={browse ? "voice-library-available" : "voice-library-curated"}
    >
      {options.map((voice) => (
        <li
          className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-accent"
          key={voice.key}
          data-testid="voice-library-row"
        >
          <span className="min-w-0 flex-1">
            <span
              className="block truncate text-sm"
              data-testid="voice-library-label"
            >
              {voice.label}
            </span>
            {voice.detail && (
              <span className="block text-xs text-muted-foreground">
                {voice.detail}
              </span>
            )}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => onPreview(voice.key)}
          >
            Preview
          </Button>
          {isAdmin &&
            (browse ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={busy || ("inLibrary" in voice && voice.inLibrary)}
                onClick={() => onAdd(voice.id)}
              >
                {"inLibrary" in voice && voice.inLibrary ? "In library" : "Add"}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => onRemove(voice)}
              >
                Remove
              </Button>
            ))}
        </li>
      ))}
    </ul>
  );
}
