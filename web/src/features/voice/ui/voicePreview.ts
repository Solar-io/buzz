/**
 * "Preview" for a voice row — ONE implementation, shared by the Settings
 * picker and the in-huddle settings popover.
 *
 * It exists as a module rather than a function inside the dialog because
 * there are now two surfaces that preview a voice, and the alternative was
 * a second copy of the lazily-created AudioContext, the bridge POST and the
 * PCM player. The bridge leg is real synthesis (`playBridgeResponse`), not
 * a stub: the silent-pocket-preview era ended when the tts bridge landed.
 *
 * The AudioContext is created on the FIRST preview, which is inside a click
 * handler — the user gesture browsers require before audio may start. A
 * failed preview never throws and never wedges the surface that asked for
 * it; the worst outcome is silence, which is also what a missing bridge
 * sounds like.
 */

import {
  playBridgeResponse,
  ttsBridgeUrl,
  type BridgeAudioContextLike,
} from "../../huddle/lib/bridgeSpeech.ts";
import { PREVIEW_SAMPLE_TEXT, type VoiceEngine } from "./voicePickerOptions.ts";
import {
  relayHostname,
  speechServiceUrl,
} from "../../../shared/lib/relay-url.ts";

/** What one preview asks the bridge for. */
export interface VoicePreviewRequest {
  engine: VoiceEngine;
  /** The selection key, prefix included: `pocket:anna` / `eleven:abc`. */
  key: string;
}

export interface VoicePreviewer {
  /** Speak the sample line through this row's own engine. */
  preview: (request: VoicePreviewRequest) => void;
  /** Release the preview AudioContext (call on unmount). */
  dispose: () => void;
}

/** Strip the engine prefix off a selection key — the bridge wants the bare id. */
export function bridgeVoiceId(request: VoicePreviewRequest): string {
  const prefix = `${request.engine === "pocket" ? "pocket" : "eleven"}:`;
  return request.key.startsWith(prefix)
    ? request.key.slice(prefix.length)
    : request.key;
}

/** Overridable seams — production passes none of these. */
export interface VoicePreviewerOptions {
  fetchImpl?: typeof fetch;
  /** Build the playback context, or return null when audio is unavailable. */
  createContext?: () => BridgeAudioContextLike | null;
  /** The host the bridge is reached on; defaults to the serving hostname. */
  hostname?: () => string;
}

function defaultContext(): BridgeAudioContextLike | null {
  if (
    typeof window === "undefined" ||
    typeof window.AudioContext === "undefined"
  ) {
    return null;
  }
  try {
    return new window.AudioContext({
      sampleRate: 24_000,
    }) as unknown as BridgeAudioContextLike;
  } catch {
    return new window.AudioContext() as unknown as BridgeAudioContextLike;
  }
}

export function createVoicePreviewer(
  options: VoicePreviewerOptions = {},
): VoicePreviewer {
  const createContext = options.createContext ?? defaultContext;
  const hostname =
    options.hostname ??
    (() => (typeof window === "undefined" ? "" : relayHostname()));
  let context: BridgeAudioContextLike | null = null;
  /** Bumped by every new preview so an in-flight one stops scheduling. */
  let token = 0;

  return {
    preview(request) {
      const host = hostname();
      if (host === "") {
        return;
      }
      if (context === null) {
        context = createContext();
      }
      const ctx = context;
      if (ctx === null) {
        return;
      }
      // An AudioContext that was created before a gesture starts suspended;
      // resuming is a no-op when it is already running.
      void (ctx as unknown as { resume?: () => Promise<void> }).resume?.();
      token += 1;
      const mine = token;
      const doFetch = options.fetchImpl ?? fetch;
      void (async () => {
        try {
          const response = await doFetch(
            options.hostname ? ttsBridgeUrl(host) : speechServiceUrl("tts"),
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                engine: request.engine,
                voice: bridgeVoiceId(request),
                text: PREVIEW_SAMPLE_TEXT,
              }),
            },
          );
          if (!response.ok || token !== mine) {
            return;
          }
          await playBridgeResponse(response, ctx, {
            shouldStop: () => token !== mine,
          });
        } catch {
          // A failed preview must never wedge the dialog.
        }
      })();
    },
    dispose() {
      token += 1;
      const ctx = context;
      context = null;
      void (
        ctx as unknown as { close?: () => Promise<void> } | null
      )?.close?.();
    },
  };
}
