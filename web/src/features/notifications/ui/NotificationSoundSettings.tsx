import { Play } from "lucide-react";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Switch } from "@/shared/ui/switch";
import { useNotificationSettings } from "../hooks";
import { updateNotificationSettings } from "../lib/settingsStore.ts";
import {
  playNotificationSound,
  SLOT_DESCRIPTIONS,
  SLOT_LABELS,
  SOUND_NAMES,
  SOUND_SLOTS,
  type SoundName,
  type SoundSlot,
} from "../lib/sound.ts";

/**
 * The "Play sounds" switch and one sound picker per slot.
 *
 * Every preview click is a real user gesture, which is also what unlocks
 * `audio.play()` for the rest of the page's life — so previewing once is the
 * reliable way to make the first real alert audible.
 */
export function NotificationSoundSettings() {
  const settings = useNotificationSettings();
  const disabled = !settings.soundEnabled;

  const choose = (slot: SoundSlot, name: SoundName) => {
    updateNotificationSettings({
      sounds: { ...settings.sounds, [slot]: name },
    });
    playNotificationSound(name);
  };

  return (
    <section className="flex flex-col gap-2" data-testid="notification-sounds">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium">Play sounds</p>
          <p className="text-2xs text-muted-foreground">
            Chime when a message notifies you. Muted channels never play a
            sound.
          </p>
        </div>
        <Switch
          aria-label="Play sounds"
          checked={settings.soundEnabled}
          data-testid="notification-sound-toggle"
          onCheckedChange={(next) =>
            updateNotificationSettings({ soundEnabled: next })
          }
        />
      </div>
      <div className="flex flex-col gap-1">
        {SOUND_SLOTS.map((slot) => {
          const id = `notification-sound-${slot}`;
          const value = settings.sounds[slot];
          return (
            <div
              className={cn(
                "flex items-center justify-between gap-3 rounded-md border border-border px-2.5 py-2",
                disabled && "opacity-60",
              )}
              key={slot}
            >
              <label className="flex min-w-0 flex-col gap-0.5" htmlFor={id}>
                <span className="text-sm">{SLOT_LABELS[slot]}</span>
                <span className="text-2xs text-muted-foreground">
                  {SLOT_DESCRIPTIONS[slot]}
                </span>
              </label>
              <span className="flex shrink-0 items-center gap-1.5">
                <select
                  className={cn(
                    "h-8 rounded-md border border-input bg-background px-2 text-sm",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  )}
                  data-testid={id}
                  disabled={disabled}
                  id={id}
                  onChange={(event) =>
                    choose(slot, event.target.value as SoundName)
                  }
                  value={value}
                >
                  {SOUND_NAMES.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
                <Button
                  aria-label={`Preview ${value}`}
                  className="h-8 w-8 p-0"
                  data-testid={`${id}-preview`}
                  disabled={disabled}
                  onClick={() => playNotificationSound(value)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <Play className="h-4 w-4" />
                </Button>
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
