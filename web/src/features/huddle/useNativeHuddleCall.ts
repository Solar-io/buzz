import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { BuzzHuddle, type NativeCallState } from "@/shared/platform/native";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { readNativeServices } from "@/shared/platform/config";
import { useProfiles } from "@/features/channels/hooks";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { useMessageActions } from "@/features/channels/lib/useMessageActions";
import type { ChannelSummary } from "@/features/channels/lib/channelFromEvent";
import { useHuddleMemberSnapshot } from "./useHuddleMemberSnapshot";
import { useHuddleAgentRoster } from "./useHuddleAgentRoster";
import { useHuddleReactions } from "./useHuddleReactions";
import { DEFAULT_HUDDLE_PREFS, loadHuddlePrefs, saveHuddlePrefs, type HuddlePrefs } from "./lib/huddlePrefs";
import { initialDuplexState } from "./lib/duplexGate";
import type { HuddleCall, HuddleCallTarget } from "./useHuddleCall";

const EMPTY: NativeCallState = { status: "idle", channelId: null, parentChannelId: null, muted: false, speaker: true, voiceEnabled: false, speechEnabled: false, speaking: false, interim: "", error: null, peers: [] };

export function useNativeHuddleCall({ target, selfPubkey }: { target: HuddleCallTarget | null; selfPubkey: string | null }): HuddleCall {
  const [state, setState] = useState(EMPTY);
  const [voiceInputMode, setVoiceInputMode] = useState<"open" | "push_to_talk">("open");
  const [pttActive, setPttActive] = useState(false);
  const [prefs, setPrefsState] = useState(DEFAULT_HUDDLE_PREFS);
  const { session } = useRelaySession();
  const channelId = state.channelId ?? target?.huddleChannelId ?? null;
  const parentChannelId = state.parentChannelId ?? target?.parentChannelId ?? null;
  const connected = state.status === "connected" || state.status === "reconnecting";
  const current = useMemo<ChannelSummary | null>(() => channelId ? { id: channelId, name: "huddle", about: "", updatedAt: 0, type: "stream", archived: false, isPrivate: false, topic: "", purpose: "", ttlDeadline: null, ttlSeconds: 3600, participantPubkeys: [] } : null, [channelId]);
  const { send } = useMessageActions({ session, current, channelId: channelId ?? "", selfPubkey });
  const members = useHuddleMemberSnapshot(connected ? channelId : null);
  const parentMembers = useHuddleMemberSnapshot(connected ? parentChannelId : null);
  const roster = useHuddleAgentRoster({ ephemeralChannelId: connected ? channelId : null, parentChannelId, ephemeral: members, parent: parentMembers });
  const profiles = useProfiles(useMemo(() => [...state.peers.map((p) => p.pubkey), ...roster.agentPubkeys], [state.peers, roster.agentPubkeys]));
  const reactions = useHuddleReactions({ channelId: connected ? channelId : null, selfPubkey, senderName: selfPubkey ? profiles.get(selfPubkey)?.displayName ?? "You" : "You" });
  const speechActivity = useRef({ speaking: false, utterances: [] });
  const speakRoutes = useRef(new Map());
  speechActivity.current.speaking = state.speaking;

  useEffect(() => {
    let alive = true;
    const listener = BuzzHuddle.addListener("state", (next) => { if (alive) setState(next); });
    void BuzzHuddle.snapshot().then((next) => { if (alive) setState(next); });
    const refresh = () => { if (!document.hidden) void BuzzHuddle.snapshot().then((next) => { if (alive) setState(next); }); };
    document.addEventListener("visibilitychange", refresh);
    return () => { alive = false; void listener.then((handle) => handle.remove()); document.removeEventListener("visibilitychange", refresh); };
  }, []);
  useEffect(() => { if (parentChannelId) setPrefsState(loadHuddlePrefs(localStorage, parentChannelId)); }, [parentChannelId]);
  const configure = useCallback((options: Parameters<typeof BuzzHuddle.configure>[0]) => {
    void BuzzHuddle.configure(options).catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Could not change call settings."));
  }, []);
  const join = useCallback(async () => {
    if (!target?.parentChannelId) return;
    try {
      const services = readNativeServices();
      setState(await BuzzHuddle.join({ relayUrl: relayWsUrl(), channelId: target.huddleChannelId, parentChannelId: target.parentChannelId, sttUrl: services?.sttUrl ?? "", ttsUrl: services?.ttsUrl ?? "" }));
    } catch (error) {
      setState((old) => ({ ...old, status: "error", error: error instanceof Error ? error.message : "Could not join huddle." }));
    }
  }, [target]);
  const leave = useCallback(() => { void BuzzHuddle.leave().catch((error: unknown) => toast.error(String(error))); }, []);
  const held = (prefs.duplex === "half" && state.speaking) || (voiceInputMode === "push_to_talk" && !pttActive);
  const setPrefs = useCallback((next: HuddlePrefs) => {
    setPrefsState(next);
    configure({ duplex: next.duplex, voiceOverride: next.voice ?? {} });
    if (parentChannelId) saveHuddlePrefs(localStorage, parentChannelId, next);
  }, [parentChannelId, configure]);
  return {
    channelId, parentChannelId, connected, reconnecting: state.status === "reconnecting", selfPubkey,
    profiles, reactions, agentPubkeys: roster.agentPubkeys, addAgent: roster.addAgent, prefs, setPrefs,
    duplex: { ...initialDuplexState(prefs.duplex), agentSpeaking: state.speaking, userMuted: state.muted, held },
    micHoldNotice: held ? "Microphone held while the agent speaks" : null,
    leave,
    send,
    huddle: {
      status: state.status, error: state.error, peers: state.peers, speaking: new Map(Object.entries(state.levels ?? {})), muted: state.muted,
      micLevel: state.micLevel ?? -127, devices: [], deviceId: "", outputDevices: [{ deviceId: "speaker", label: "Speaker" }, { deviceId: "receiver", label: "Receiver / connected headphones" }], outputDeviceId: state.speaker ? "speaker" : "receiver", speakerMuted: state.speakerMuted ?? false,
      supportsOutputSelection: true, held, voiceInputMode, pttActive, micLive: connected && !held && !state.muted,
      supportsVoice: true, join, leave, toggleMute: () => configure({ muted: !state.muted }),
      toggleSpeakerMuted: () => configure({ speakerMuted: !state.speakerMuted }),
      selectDevice: async () => { throw new Error("Choose the microphone in iOS audio routing."); }, selectOutputDevice: async (device) => { await BuzzHuddle.configure({ speaker: device === "speaker" }); return true; },
      setHeld: (held) => configure({ held }),
      setVoiceInputMode: (mode) => { setVoiceInputMode(mode); configure({ held: mode === "push_to_talk" && !pttActive }); },
      setPushToTalkActive: (active) => { setPttActive(active); configure({ held: voiceInputMode === "push_to_talk" && !active }); },
      subscribeMicFrames: () => { throw new Error("Native microphone frames stay inside the native call engine."); },
      resumeAudio: async () => { await BuzzHuddle.snapshot(); },
    },
    voice: { supported: true, enabled: state.voiceEnabled, setEnabled: (enabled) => configure({ voiceEnabled: enabled, ...(enabled ? { speechEnabled: true } : {}) }), offReason: null, status: state.voiceEnabled ? "listening" : "idle", interimText: state.interim, error: state.error },
    speech: {
      supported: true, enabled: state.speechEnabled, setEnabled: (enabled) => configure({ speechEnabled: enabled }),
      agentPubkeys: new Set(roster.agentPubkeys), membershipKnown: members.known, suppressedAgents: state.peers.map((p) => p.pubkey),
      speaking: state.speaking, speechActivity, speakRoutes,
      interrupt: () => configure({ interrupt: true }),
      setOutputDevice: (device) => configure({ speaker: device === "speaker" }), setMuted: (muted) => configure({ speakerMuted: muted }),
    },
  };
}
