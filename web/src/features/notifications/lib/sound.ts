/**
 * Notification sounds for the browser client.
 *
 * The sound files are the desktop's (`desktop/public/sounds/`), shipped from
 * `public/assets/sounds/` because the relay serves only `/assets/*` as files —
 * anything else falls through to the SPA index, so `/sounds/x.mp3` would
 * deploy as HTML and play nothing.
 *
 * Web has four slots rather than the desktop's eight: there is no thread
 * follow model or agent-job feed here, and a reminder is the browser's only
 * "needs action" alert.
 */

export const SOUND_NAMES = [
  "bong",
  "boo",
  "dng",
  "doo",
  "doodone",
  "doong",
  "doop",
  "flirl",
  "flutter",
  "oh-no",
  "ping",
  "unison",
] as const;
export type SoundName = (typeof SOUND_NAMES)[number];

export const SOUND_SLOTS = ["dm", "mention", "channel", "reminder"] as const;
export type SoundSlot = (typeof SOUND_SLOTS)[number];

export type SlotSounds = Record<SoundSlot, SoundName>;

export const SLOT_LABELS: Record<SoundSlot, string> = {
  dm: "Direct messages",
  mention: "@Mentions",
  channel: "Channel messages",
  reminder: "Reminders",
};

export const SLOT_DESCRIPTIONS: Record<SoundSlot, string> = {
  dm: "When someone messages you directly.",
  mention: "When someone tags you in a channel.",
  channel: "Any other message that notifies you.",
  reminder: "When a reminder comes due.",
};

export const DEFAULT_SLOT_SOUNDS: SlotSounds = {
  dm: "unison",
  mention: "ping",
  channel: "doop",
  reminder: "doodone",
};

export function isSoundName(value: unknown): value is SoundName {
  return (
    typeof value === "string" &&
    (SOUND_NAMES as readonly string[]).includes(value)
  );
}

/**
 * Which slot a message's sound comes from. A DM outranks a mention: every DM
 * p-tags its peers, so "mentions you" is true of nearly all of them and would
 * otherwise swallow the DM slot entirely.
 */
export function soundSlotFor(message: {
  isDm: boolean;
  mentionsSelf: boolean;
}): SoundSlot {
  if (message.isDm) return "dm";
  if (message.mentionsSelf) return "mention";
  return "channel";
}

/** URL of a sound file, as served by the relay. */
export function soundUrl(name: SoundName): string {
  return `/assets/sounds/${name}.mp3`;
}

const cache = new Map<SoundName, HTMLAudioElement>();

function getAudio(name: SoundName): HTMLAudioElement {
  let audio = cache.get(name);
  if (!audio) {
    audio = new Audio(soundUrl(name));
    cache.set(name, audio);
  }
  return audio;
}

/**
 * Play a sound, best-effort. Browsers refuse `play()` until the page has seen
 * a user gesture; that rejection is swallowed, since a missed chime is not an
 * error worth surfacing. Returns the element so a preview can track playback.
 */
export function playNotificationSound(
  name: SoundName,
): HTMLAudioElement | null {
  try {
    const audio = getAudio(name);
    audio.currentTime = 0;
    const played = audio.play();
    // Older engines return undefined rather than a Promise.
    played?.catch(() => {});
    return audio;
  } catch {
    return null;
  }
}
