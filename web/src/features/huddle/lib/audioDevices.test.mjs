import assert from "node:assert/strict";
import { test } from "node:test";

const {
  AUDIO_DEVICE_PREFS_KEY,
  DEFAULT_AUDIO_DEVICE_PREFS,
  SINK_ID_UNSUPPORTED_MESSAGE,
  audioInputOptions,
  audioOutputOptions,
  devicePresent,
  isSystemDefault,
  loadAudioDevicePrefs,
  patchAudioDevicePrefs,
  resolveDeviceId,
  saveAudioDevicePrefs,
  supportsSinkId,
} = await import("./audioDevices.ts");

// A mixed enumeration, the shape a browser actually returns: some labelled,
// some not (no mic grant yet), and a video device that belongs to neither
// audio list.
const DEVICES = [
  { deviceId: "default", kind: "audioinput", label: "Default - MacBook Mic" },
  { deviceId: "mic-usb", kind: "audioinput", label: "" },
  { deviceId: "cam", kind: "videoinput", label: "FaceTime HD" },
  { deviceId: "spk-default", kind: "audiooutput", label: "Default - Speakers" },
  { deviceId: "spk-bt", kind: "audiooutput", label: "" },
  { deviceId: "spk-hdmi", kind: "audiooutput", label: "LG HDR 4K" },
];

function memoryStore(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, value),
  };
}

test("audioInputOptions lists microphones only", () => {
  const options = audioInputOptions(DEVICES);
  assert.equal(options.length, 2, "two audioinput devices, nothing else");
  assert.deepEqual(
    options.map((option) => option.deviceId),
    ["default", "mic-usb"],
  );
  // The discriminating cases: a speaker and a camera must NOT be here.
  assert.ok(!options.some((option) => option.deviceId.startsWith("spk-")));
  assert.ok(!options.some((option) => option.deviceId === "cam"));
});

test("audioOutputOptions lists speakers only", () => {
  const options = audioOutputOptions(DEVICES);
  assert.equal(options.length, 3, "three audiooutput devices, nothing else");
  assert.deepEqual(
    options.map((option) => option.deviceId),
    ["spk-default", "spk-bt", "spk-hdmi"],
  );
  // The discriminating case: a microphone in the SPEAKER menu would route
  // playback nowhere, so it must not appear.
  assert.ok(!options.some((option) => option.deviceId === "mic-usb"));
  assert.ok(!options.some((option) => option.deviceId === "cam"));
});

test("unlabelled devices get positional fallbacks, per list", () => {
  assert.deepEqual(
    audioInputOptions(DEVICES).map((option) => option.label),
    ["Default - MacBook Mic", "Microphone 2"],
  );
  assert.deepEqual(
    audioOutputOptions(DEVICES).map((option) => option.label),
    ["Default - Speakers", "Speaker 2", "LG HDR 4K"],
  );
  // A grantless enumeration — every label empty — still names every row.
  const blank = audioInputOptions([
    { deviceId: "a", kind: "audioinput", label: "" },
    { deviceId: "b", kind: "audioinput", label: "" },
  ]);
  assert.deepEqual(
    blank.map((option) => option.label),
    ["Microphone 1", "Microphone 2"],
  );
});

test("the system default is recognised under both spellings", () => {
  assert.equal(isSystemDefault(""), true, "the app's unset spelling");
  assert.equal(isSystemDefault("default"), true, "the browser's spelling");
  assert.equal(isSystemDefault("mic-usb"), false);
});

test("supportsSinkId feature-tests the constructor prototype", () => {
  class WithSink {}
  WithSink.prototype.setSinkId = () => {};
  class WithoutSink {}
  assert.equal(supportsSinkId(WithSink), true, "Chromium-shaped");
  assert.equal(supportsSinkId(WithoutSink), false, "Safari/Firefox-shaped");
  assert.equal(supportsSinkId(undefined), false, "no AudioContext at all");
  assert.equal(supportsSinkId(null), false);
  assert.match(SINK_ID_UNSUPPORTED_MESSAGE, /Brave, Chrome or Edge/);
});

test("device prefs round-trip and survive a hostile store", () => {
  const store = memoryStore();
  saveAudioDevicePrefs(store, {
    inputDeviceId: "mic-usb",
    outputDeviceId: "spk-bt",
  });
  assert.equal(store.map.size, 1);
  assert.ok(store.map.has(AUDIO_DEVICE_PREFS_KEY));
  assert.deepEqual(loadAudioDevicePrefs(store), {
    inputDeviceId: "mic-usb",
    outputDeviceId: "spk-bt",
  });

  for (const raw of ["", "not json", "null", '"text"', '{"inputDeviceId":9}']) {
    assert.deepEqual(
      loadAudioDevicePrefs(memoryStore({ [AUDIO_DEVICE_PREFS_KEY]: raw })),
      DEFAULT_AUDIO_DEVICE_PREFS,
      `malformed payload ${JSON.stringify(raw)}`,
    );
  }
  const throwing = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
  };
  assert.deepEqual(loadAudioDevicePrefs(throwing), DEFAULT_AUDIO_DEVICE_PREFS);
  assert.doesNotThrow(() =>
    saveAudioDevicePrefs(throwing, DEFAULT_AUDIO_DEVICE_PREFS),
  );
  assert.deepEqual(loadAudioDevicePrefs(null), DEFAULT_AUDIO_DEVICE_PREFS);
});

test("a remembered device that was unplugged falls back to the system default", () => {
  const outputs = audioOutputOptions(DEVICES);
  assert.equal(devicePresent("spk-bt", outputs), true);
  assert.equal(devicePresent("spk-gone", outputs), false);
  assert.equal(devicePresent("", outputs), true, "the default is always there");
  // The point of the fallback: passing a vanished id to getUserMedia as an
  // `exact` constraint fails the whole join.
  assert.equal(resolveDeviceId("spk-bt", outputs), "spk-bt");
  assert.equal(resolveDeviceId("spk-gone", outputs), "");
});

test("patchAudioDevicePrefs merges rather than clobbering the other side", () => {
  const store = memoryStore();
  patchAudioDevicePrefs(store, { inputDeviceId: "mic-usb" });
  patchAudioDevicePrefs(store, { outputDeviceId: "spk-bt" });
  // The discriminating case: a whole-record write would have dropped the
  // mic id when the speaker was chosen.
  assert.deepEqual(loadAudioDevicePrefs(store), {
    inputDeviceId: "mic-usb",
    outputDeviceId: "spk-bt",
  });
});
