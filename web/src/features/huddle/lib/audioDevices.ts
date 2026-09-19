/**
 * Audio device lists and their persistence — the pure half of the huddle's
 * mic and speaker pickers.
 *
 * Two asymmetries the UI has to respect, both browser facts rather than
 * choices:
 *
 *  LABELS ARE EMPTY WITHOUT A GRANT. `enumerateDevices()` returns entries
 *  with `label: ""` until the page holds a microphone permission — a
 *  privacy rule, not a bug. So every option gets a positional fallback
 *  ("Microphone 2", "Speaker 3") and the list is re-read after join, when
 *  the real names finally arrive.
 *
 *  OUTPUT SELECTION IS NOT UNIVERSAL. Routing playback to a chosen speaker
 *  needs `AudioContext.setSinkId`, which Chromium has and Safari and
 *  Firefox do not. {@link supportsSinkId} is the feature test, and
 *  {@link SINK_ID_UNSUPPORTED_MESSAGE} is what the disabled menu says —
 *  a disabled control that explains itself, never a control that silently
 *  does nothing.
 *
 * Import-free so `node --test` loads it.
 */

/** The slice of `MediaDeviceInfo` this module reads. */
export interface MediaDeviceLike {
  deviceId: string;
  kind: string;
  label: string;
}

/** One row in a device menu. */
export interface AudioDeviceOption {
  deviceId: string;
  label: string;
}

/**
 * The id that means "whatever the system picks". The empty string is the
 * app's own spelling (an unset preference); browsers additionally emit a
 * literal `"default"` device. Both are the same answer to the user.
 */
export const SYSTEM_DEFAULT_DEVICE_ID = "";

export function isSystemDefault(deviceId: string): boolean {
  return deviceId === "" || deviceId === "default";
}

function labelled(
  devices: readonly MediaDeviceLike[],
  kind: string,
  fallbackNoun: string,
): AudioDeviceOption[] {
  return devices
    .filter((device) => device.kind === kind)
    .map((device, index) => ({
      deviceId: device.deviceId,
      label: device.label || `${fallbackNoun} ${index + 1}`,
    }));
}

/** Microphones, in enumeration order, with positional label fallbacks. */
export function audioInputOptions(
  devices: readonly MediaDeviceLike[],
): AudioDeviceOption[] {
  return labelled(devices, "audioinput", "Microphone");
}

/** Speakers / headsets, same treatment. */
export function audioOutputOptions(
  devices: readonly MediaDeviceLike[],
): AudioDeviceOption[] {
  return labelled(devices, "audiooutput", "Speaker");
}

/**
 * Does this browser let a page route playback to a chosen output device?
 *
 * The test is on the CONSTRUCTOR's prototype rather than on an instance: a
 * huddle asks this before it has built an AudioContext (the pre-join menu),
 * and constructing one just to feature-test would need a user gesture.
 */
export function supportsSinkId(
  constructor: { prototype?: unknown } | undefined | null,
): boolean {
  const prototype = constructor?.prototype;
  if (prototype === undefined || prototype === null) {
    return false;
  }
  return typeof prototype === "object" && "setSinkId" in prototype;
}

/** What the disabled speaker menu tells the user, verbatim. */
export const SINK_ID_UNSUPPORTED_MESSAGE =
  "Speaker selection needs Brave, Chrome or Edge";

/** The devices a viewer chose, remembered across joins and reloads. */
export interface AudioDevicePrefs {
  inputDeviceId: string;
  outputDeviceId: string;
}

export const DEFAULT_AUDIO_DEVICE_PREFS: AudioDevicePrefs = {
  inputDeviceId: SYSTEM_DEFAULT_DEVICE_ID,
  outputDeviceId: SYSTEM_DEFAULT_DEVICE_ID,
};

/**
 * One key for the whole browser, not one per channel: a headset is a
 * property of the machine, not of the room.
 */
export const AUDIO_DEVICE_PREFS_KEY = "buzz.huddle.devices";

/** The slice of `Storage` this module uses (injected so tests need no DOM). */
export interface AudioDevicePrefsStore {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export function loadAudioDevicePrefs(
  store: AudioDevicePrefsStore | null,
): AudioDevicePrefs {
  if (store === null) {
    return DEFAULT_AUDIO_DEVICE_PREFS;
  }
  let raw: string | null = null;
  try {
    raw = store.getItem(AUDIO_DEVICE_PREFS_KEY);
  } catch {
    return DEFAULT_AUDIO_DEVICE_PREFS;
  }
  if (raw === null) {
    return DEFAULT_AUDIO_DEVICE_PREFS;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_AUDIO_DEVICE_PREFS;
  }
  if (parsed === null || typeof parsed !== "object") {
    return DEFAULT_AUDIO_DEVICE_PREFS;
  }
  const record = parsed as { inputDeviceId?: unknown; outputDeviceId?: unknown };
  return {
    inputDeviceId:
      typeof record.inputDeviceId === "string"
        ? record.inputDeviceId
        : SYSTEM_DEFAULT_DEVICE_ID,
    outputDeviceId:
      typeof record.outputDeviceId === "string"
        ? record.outputDeviceId
        : SYSTEM_DEFAULT_DEVICE_ID,
  };
}

export function saveAudioDevicePrefs(
  store: AudioDevicePrefsStore | null,
  prefs: AudioDevicePrefs,
): void {
  if (store === null) {
    return;
  }
  try {
    store.setItem(AUDIO_DEVICE_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // A blocked or full store must not break a live call.
  }
}

/**
 * Is a remembered device still present?
 *
 * A saved id for an unplugged headset would otherwise be passed to
 * `getUserMedia` as an `exact` constraint and fail the whole join. The
 * system default is always "present".
 */
export function devicePresent(
  deviceId: string,
  options: readonly AudioDeviceOption[],
): boolean {
  if (isSystemDefault(deviceId)) {
    return true;
  }
  return options.some((option) => option.deviceId === deviceId);
}

/**
 * The id a picker should actually apply: the remembered one when it is
 * still plugged in, the system default otherwise.
 */
export function resolveDeviceId(
  savedDeviceId: string,
  options: readonly AudioDeviceOption[],
): string {
  return devicePresent(savedDeviceId, options)
    ? savedDeviceId
    : SYSTEM_DEFAULT_DEVICE_ID;
}
