import { isNativeIOS } from "../platform/native.ts";
import { readNativeServices } from "../platform/config.ts";

/** Convert a WebSocket relay URL to its HTTP equivalent. */
export function relayHttpUrl(wsUrl: string): string {
  if (wsUrl.startsWith("wss://")) {
    return `https://${wsUrl.slice(6)}`;
  }
  if (wsUrl.startsWith("ws://")) {
    return `http://${wsUrl.slice(5)}`;
  }
  return wsUrl;
}

/** Read the relay WebSocket URL from environment or derive from window.location. */
export function relayWsUrl(): string {
  if (isNativeIOS()) {
    const relay = readNativeServices()?.relayUrl;
    if (!relay) throw new Error("Configure the native app's relay first.");
    return relay;
  }
  const envUrl = import.meta.env.VITE_RELAY_URL;
  if (envUrl) return envUrl;
  // Same-origin: derive from current page location (works when served from relay)
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}`;
}

export function relayHostname(): string { return new URL(relayWsUrl()).hostname; }

/** Native origin is capacitor://localhost, never a service host. */
export function speechServiceUrl(kind: "stt" | "tts"): string {
  const configured = readNativeServices();
  const explicit = kind === "stt"
    ? (isNativeIOS() ? configured?.sttUrl : import.meta.env.VITE_STT_URL)
    : (isNativeIOS() ? configured?.ttsUrl : import.meta.env.VITE_TTS_URL);
  if (explicit) return explicit;
  if (isNativeIOS()) throw new Error("Configure speech service addresses in the native connection settings.");
  return kind === "stt" ? `wss://${relayHostname()}:6361/stt` : `https://${relayHostname()}:6366/tts`;
}

/** HTTP base URL for the relay (derived from the WS URL). */
export function relayHttpBaseUrl(): string {
  return relayHttpUrl(relayWsUrl());
}
