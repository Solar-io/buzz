import {
  Capacitor,
  registerPlugin,
  type PluginListenerHandle,
} from "@capacitor/core";
import type {
  SignedNostrEvent,
  UnsignedNostrEvent,
} from "../lib/nostr-signer.ts";

export const isNativeIOS = () =>
  Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";

export interface NativeIdentityState {
  pubkey: string | null;
  locked: boolean;
}
export interface LegacyIdentityRestore {
  status: "existing" | "migrated" | "none" | "choice";
  relayUrl?: string;
  pubkey?: string;
  choices?: Array<{
    id: string;
    name: string;
    relayUrl: string;
    pubkey: string;
  }>;
}

export const BuzzIdentity = registerPlugin<{
  state(): Promise<NativeIdentityState>;
  restoreFlutter(options: {
    selectedId?: string;
  }): Promise<LegacyIdentityRestore>;
  enroll(options: { secretHex: string }): Promise<NativeIdentityState>;
  unlock(): Promise<NativeIdentityState>;
  lock(): Promise<void>;
  forget(): Promise<void>;
  signEvent(options: {
    event: UnsignedNostrEvent;
  }): Promise<{ event: SignedNostrEvent }>;
  encrypt(options: {
    peer: string;
    plaintext: string;
  }): Promise<{ ciphertext: string }>;
  decrypt(options: {
    peer: string;
    ciphertext: string;
  }): Promise<{ plaintext: string }>;
}>("BuzzIdentity");

export interface NativePushPlugin {
  requestAuthorizationAndRegister(): Promise<{ granted: boolean }>;
  apnsToken(): Promise<{ token: string | null }>;
  isSupported(): Promise<{ supported: boolean; appProfile?: string }>;
  generateKey(): Promise<{ keyId: string }>;
  attest(options: {
    keyId: string;
    clientDataHash: string;
  }): Promise<{ attestation: string }>;
  assertKey(options: {
    keyId: string;
    clientDataHash: string;
  }): Promise<{ assertion: string }>;
  readState(options: { scope: string }): Promise<{ value: string | null }>;
  writeState(options: { scope: string; value: string | null }): Promise<void>;
  getWake(): Promise<{ wakeId: string | null }>;
  acknowledgeWake(options: { wakeId: string }): Promise<void>;
  addListener(
    event: "token",
    listener: (event: { token: string }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    event: "wake",
    listener: (event: { wakeId: string }) => void,
  ): Promise<PluginListenerHandle>;
}
export const BuzzPush = registerPlugin<NativePushPlugin>("BuzzPush");

export interface NativeCallState {
  status: "idle" | "connecting" | "connected" | "reconnecting" | "error";
  channelId: string | null;
  parentChannelId: string | null;
  muted: boolean;
  speaker: boolean;
  voiceEnabled: boolean;
  voiceStatus?: "idle" | "starting" | "listening" | "error";
  voiceOffReason?: "bridge_error" | "reconnect_cap" | null;
  speechEnabled: boolean;
  speaking: boolean;
  speakerMuted?: boolean;
  micLevel?: number;
  levels?: Record<string, number>;
  interim: string;
  error: string | null;
  peers: Array<{ pubkey: string; peerIndex: number; epoch: number }>;
}
export const BuzzHuddle = registerPlugin<{
  snapshot(): Promise<NativeCallState>;
  join(options: {
    relayUrl: string;
    channelId: string;
    parentChannelId: string;
    sttUrl: string;
    ttsUrl: string;
  }): Promise<NativeCallState>;
  leave(): Promise<void>;
  configure(options: {
    muted?: boolean;
    speaker?: boolean;
    speakerMuted?: boolean;
    voiceEnabled?: boolean;
    speechEnabled?: boolean;
    held?: boolean;
    duplex?: "half" | "barge";
    voiceOverride?: { engine?: string; key?: string };
    interrupt?: boolean;
  }): Promise<void>;
  addListener(
    event: "state",
    listener: (state: NativeCallState) => void,
  ): Promise<PluginListenerHandle>;
}>("BuzzHuddle");
