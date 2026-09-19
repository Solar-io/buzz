import { useCallback, useRef, useState } from "react";

import { applySinkId, type MediaDeviceLike } from "./lib/huddleAudioGraph.ts";
import {
  audioOutputOptions,
  isSystemDefault,
  loadAudioDevicePrefs,
  patchAudioDevicePrefs,
  resolveDeviceId,
  supportsSinkId,
  type AudioDeviceOption,
} from "./lib/audioDevices.ts";

/**
 * Where this browser PLAYS a huddle: which speaker, and whether it is
 * muted.
 *
 * Split out of `useHuddleAudio` because it is a different question from
 * capture and has a different failure mode. Capture fails loudly (a denied
 * mic ends the join); output selection can simply be unavailable — Safari
 * and Firefox have no `AudioContext.setSinkId` — and the honest response to
 * that is a disabled menu that says why, not a control that silently does
 * nothing.
 *
 * The speaker mute is a GAIN NODE rather than a per-source flag, because a
 * jitter buffer means audio is scheduled up to a fifth of a second ahead:
 * muting has to silence what is already queued, not just what arrives next.
 * The same node is the destination every decoded peer frame connects to
 * (`lib/peerPlayback.ts`), and the agent's TTS context is routed at the
 * same device id by `useHuddleAgentSpeech` — which is what makes the dock's
 * one speaker button mean "everything".
 */
export interface HuddleOutput {
  devices: AudioDeviceOption[];
  deviceId: string;
  muted: boolean;
  /** False on Safari/Firefox: the menu renders disabled, with the reason. */
  supported: boolean;
  /** Resolves false when the routing did not actually happen. */
  selectDevice: (deviceId: string) => Promise<boolean>;
  toggleMuted: () => void;
  /** Refresh the speaker list from one shared `enumerateDevices()` call. */
  applyEnumeration: (devices: readonly MediaDeviceLike[]) => void;
  /** Build the call's output gain and apply the remembered device. */
  attach: (context: AudioContext) => GainNode;
  /** Forget the call's gain (the context is closed by the caller). */
  detach: () => void;
}

function outputStore(): Storage | null {
  return typeof window !== "undefined" && window.localStorage
    ? window.localStorage
    : null;
}

export function useHuddleOutput(
  getContext: () => AudioContext | null,
): HuddleOutput {
  const [devices, setDevices] = useState<AudioDeviceOption[]>([]);
  const [deviceId, setDeviceIdState] = useState(
    () => loadAudioDevicePrefs(outputStore()).outputDeviceId,
  );
  const [muted, setMuted] = useState(false);
  const [supported] = useState(() =>
    supportsSinkId(
      typeof window === "undefined" ? undefined : window.AudioContext,
    ),
  );
  const deviceIdRef = useRef(deviceId);
  const mutedRef = useRef(false);
  const gainRef = useRef<GainNode | null>(null);

  const applyEnumeration = useCallback((all: readonly MediaDeviceLike[]) => {
    const options = audioOutputOptions(all);
    setDevices(options);
    // A remembered speaker that has been unplugged must not be handed to
    // setSinkId (it rejects) or left showing in the menu as current.
    const resolved = resolveDeviceId(deviceIdRef.current, options);
    if (resolved !== deviceIdRef.current) {
      deviceIdRef.current = resolved;
      setDeviceIdState(resolved);
    }
  }, []);

  const selectDevice = useCallback(
    async (next: string) => {
      deviceIdRef.current = next;
      setDeviceIdState(next);
      patchAudioDevicePrefs(outputStore(), { outputDeviceId: next });
      const context = getContext();
      if (context === null) {
        // Nothing is playing yet; the preference lands at the next join.
        return true;
      }
      return applySinkId(context, next);
    },
    [getContext],
  );

  const toggleMuted = useCallback(() => {
    setMuted((current) => {
      const next = !current;
      mutedRef.current = next;
      const gain = gainRef.current;
      if (gain) {
        gain.gain.value = next ? 0 : 1;
      }
      return next;
    });
  }, []);

  const attach = useCallback((context: AudioContext) => {
    const gain = context.createGain();
    gain.gain.value = mutedRef.current ? 0 : 1;
    gain.connect(context.destination);
    gainRef.current = gain;
    if (!isSystemDefault(deviceIdRef.current)) {
      void applySinkId(context, deviceIdRef.current);
    }
    return gain;
  }, []);

  const detach = useCallback(() => {
    gainRef.current?.disconnect();
    gainRef.current = null;
  }, []);

  return {
    devices,
    deviceId,
    muted,
    supported,
    selectDevice,
    toggleMuted,
    applyEnumeration,
    attach,
    detach,
  };
}
