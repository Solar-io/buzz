/**
 * The constants and one-liners the huddle's audio graph is assembled from.
 *
 * Split out of `useHuddleAudio.ts` so that hook stays a lifecycle — join,
 * redial, recover, leave — rather than a lifecycle plus a pile of magic
 * numbers and an inline worklet. Nothing here holds state; everything is
 * either a tuned constant with its reason attached or a pure builder.
 *
 * Import-free, so `node --test` loads it.
 */

/** The slice of `MediaDeviceInfo` the device helpers read. */
export type { MediaDeviceLike } from "./audioDevices.ts";

/** µs per 48 kHz sample (WebCodecs timestamps are µs). */
export const US_PER_SAMPLE = 1_000_000 / 48_000;

/** Playback lead-in: schedule audio this far ahead of now (jitter buffer). */
export const PLAYBACK_LEAD_S = 0.12;

/** Speaking-indicator refresh cadence. */
export const SPEAKING_TICK_MS = 250;

/**
 * Redial delays after an unexpected audio-socket drop, in ms. The DESKTOP's
 * ladder exactly (desktop/src/features/huddle/HuddleContext.tsx — the list
 * `[0, 100, 250, 500, 1_000, 2_000, 2_000]`, sized for endpoint-drain
 * handoff): early retries catch a blip fast, the 2s tail covers a relay
 * restart. Only the SOCKET is redialed — mic, context, and encoder stay
 * live, so a successful reconnect is a short audio gap, not a rejoin. When
 * the ladder runs out the call ends with the reason on screen.
 */
export const RECONNECT_DELAYS_MS = [0, 100, 250, 500, 1_000, 2_000, 2_000];

/** The uplink tap: every captured frame, posted to the main thread. */
export const WORKLET_SOURCE = `
  class UplinkTap extends AudioWorkletProcessor {
    process(inputs) {
      const input = inputs[0][0];
      if (input) this.port.postMessage(input.slice(0));
      return true;
    }
  }
  registerProcessor('uplink-tap', UplinkTap);
`;

/**
 * Capture constraints for one microphone.
 *
 * A chosen device is a REQUIREMENT, not a hint: `exact` makes the browser
 * fail loudly if that mic was unplugged, instead of quietly opening a
 * different one and leaving the picker lying about it. The empty id means
 * "system default" and carries no device constraint at all.
 */
export function micConstraints(deviceId: string): MediaTrackConstraints {
  return {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  };
}

/** The Chromium-only output-routing surface, as a structural type. */
interface SinkCapableContext {
  setSinkId?: (sinkId: string) => Promise<void>;
}

/**
 * Route one AudioContext's playback at a chosen output device.
 *
 * Resolves false — never throws — when the browser has no `setSinkId`
 * (Safari, Firefox) or the device has vanished. The caller keeps the
 * preference either way; what it must not do is claim the routing happened.
 */
export async function applySinkId(
  context: unknown,
  deviceId: string,
): Promise<boolean> {
  const sinkable = context as SinkCapableContext | null;
  if (sinkable === null || typeof sinkable?.setSinkId !== "function") {
    return false;
  }
  try {
    await sinkable.setSinkId(deviceId);
    return true;
  } catch {
    return false;
  }
}
