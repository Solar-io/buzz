import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { useProfiles } from "@/features/channels/hooks";
import { authorLabel } from "@/features/channels/ui/ChannelTimeline";
import type { ChannelSummary } from "@/features/channels/lib/channelFromEvent";
import { useMessageActions } from "@/features/channels/lib/useMessageActions.ts";
import { useCustomEmoji } from "@/features/custom-emoji/hooks";
import { reactionEmojiUrl } from "@/features/custom-emoji/lib/customEmoji.ts";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";

import {
  initialDuplexState,
  micHoldNotice,
  nextMicHold,
  type DuplexEvent,
  type DuplexState,
} from "./lib/duplexGate.ts";
import {
  DEFAULT_HUDDLE_PREFS,
  loadHuddlePrefs,
  saveHuddlePrefs,
  type HuddlePrefs,
} from "./lib/huddlePrefs.ts";
import {
  clearHuddleVoiceState,
  loadHuddleVoiceState,
  saveHuddleVoiceState,
  voiceRestoreAnnouncement,
  type VoiceStateStore,
} from "./lib/huddleVoicePersistence.ts";
import { isSpeaking } from "./lib/micMeter.ts";
import { publishVoiceFinal } from "./lib/voicePublish.ts";
import {
  ECHO_TAIL_MS,
  shouldRestoreSpeechOnVoiceOff,
} from "./lib/voiceTranscript.ts";
import { useHuddleAgentRoster } from "./useHuddleAgentRoster";
import { useHuddleAgentSpeech } from "./useHuddleAgentSpeech";
import { useHuddleAudio } from "./useHuddleAudio";
import { useHuddleMemberSnapshot } from "./useHuddleMemberSnapshot";
import { useHuddleReactions } from "./useHuddleReactions";
import { useHuddleVoiceMode } from "./useHuddleVoiceMode";
import { isNativeIOS } from "@/shared/platform/native";
import { useNativeHuddleCall } from "./useNativeHuddleCall";

/**
 * ONE huddle call, owned above the router.
 *
 * Everything that used to live inside `HuddleBar` and therefore died when
 * the route changed — the audio socket, voice mode, agent speech, the
 * reaction feed, the agent roster, and the armed-state persistence that
 * couples them — lives here instead. The bar is now a join surface; this is
 * the call.
 *
 * The move is why the dock and the floating panel can exist at all: a call
 * that unmounts when you open another channel cannot be docked to the
 * channel it started in, and cannot float over anything else.
 *
 * SEMANTICS ARE MOVED, NOT REWRITTEN. The coupling between voice mode and
 * agent reading, the forced-drop rules (`shouldRestoreSpeechOnVoiceOff`),
 * the fresh-add roster wait on voice publishes, and the sessionStorage
 * restore all behave exactly as they did in the bar — including which of
 * them fire on a forced drop, which is the SILENT DISARM contract.
 *
 * NEW here, because it needs the whole call in one place: the duplex gate
 * (`lib/duplexGate.ts`). Half-duplex parks the mic while the agent speaks
 * and releases it a tail later; barge-in leaves the mic hot and cancels her
 * playback when the viewer actually speaks over her.
 */

/** The store the armed voice state persists to (null outside a browser). */
function voiceStore(): VoiceStateStore | null {
  return typeof window !== "undefined" && window.sessionStorage
    ? window.sessionStorage
    : null;
}

function prefsStore(): Storage | null {
  return typeof window !== "undefined" && window.localStorage
    ? window.localStorage
    : null;
}

export interface HuddleCallTarget {
  huddleChannelId: string;
  /** Linked parent channel — the audio room requires it for ephemeral joins. */
  parentChannelId: string | null;
}

export type HuddleCall = ReturnType<typeof useBrowserHuddleCall>;

// Platform is immutable for this process. Selecting the hook once keeps the
// browser audio hooks entirely unmounted in the native application.
export const useHuddleCall = isNativeIOS()
  ? useNativeHuddleCall
  : useBrowserHuddleCall;

function useBrowserHuddleCall(options: {
  /** The call in progress, or null when nothing is active. */
  target: HuddleCallTarget | null;
  selfPubkey: string | null;
}) {
  const { target, selfPubkey } = options;
  const { session } = useRelaySession();
  const channelId = target?.huddleChannelId ?? null;
  const parentChannelId = target?.parentChannelId ?? null;

  const huddle = useHuddleAudio(channelId, parentChannelId);
  const connected =
    huddle.status === "connected" || huddle.status === "reconnecting";

  // The huddle channel's own send — the same `useMessageActions` path the
  // route builds for the open channel, constructed here for the huddle
  // channel so voice finals are signed, threaded and counted exactly like
  // typed messages. A huddle channel is never a DM, so the DM auto-tagging
  // branch inside that hook is deliberately inert.
  const huddleChannel = useMemo<ChannelSummary | null>(
    () =>
      channelId === null
        ? null
        : {
            id: channelId,
            name: "huddle",
            about: "",
            updatedAt: 0,
            type: "stream",
            archived: false,
            isPrivate: false,
            topic: "",
            purpose: "",
            ttlDeadline: null,
            ttlSeconds: 3600,
            participantPubkeys: [],
          },
    [channelId],
  );
  const { send } = useMessageActions({
    session,
    current: huddleChannel,
    channelId: channelId ?? "",
    selfPubkey,
  });

  const pubkeys = useMemo(
    () => huddle.peers.map((peer) => peer.pubkey).concat(selfPubkey ?? []),
    [huddle.peers, selfPubkey],
  );
  const profiles = useProfiles(pubkeys);
  const customEmoji = useCustomEmoji();
  const senderName = selfPubkey ? authorLabel(selfPubkey, profiles) : "Someone";
  const resolveEmojiUrl = useCallback(
    (emoji: string) => reactionEmojiUrl(emoji, customEmoji),
    [customEmoji],
  );
  const reactions = useHuddleReactions({
    channelId: connected ? channelId : null,
    selfPubkey,
    senderName,
    resolveEmojiUrl,
  });
  const audioPeerPubkeys = useMemo(
    () => huddle.peers.map((peer) => peer.pubkey),
    [huddle.peers],
  );
  // ONE poller per channel, shared by the speech gate and the agent roster
  // (two on the same channel doubled REQ/CLOSE churn and could trip the
  // relay's per-second write quota alongside a publish).
  const ephemeralMembers = useHuddleMemberSnapshot(
    connected ? channelId : null,
  );
  const parentMembers = useHuddleMemberSnapshot(
    connected ? parentChannelId : null,
  );

  // ── Per-channel preferences (S4) ────────────────────────────────────────
  const [prefs, setPrefsState] = useState<HuddlePrefs>(DEFAULT_HUDDLE_PREFS);
  useEffect(() => {
    setPrefsState(
      parentChannelId === null
        ? DEFAULT_HUDDLE_PREFS
        : loadHuddlePrefs(prefsStore(), parentChannelId),
    );
  }, [parentChannelId]);
  const setPrefs = useCallback(
    (next: HuddlePrefs) => {
      setPrefsState(next);
      if (parentChannelId !== null) {
        saveHuddlePrefs(prefsStore(), parentChannelId, next);
      }
    },
    [parentChannelId],
  );

  const speech = useHuddleAgentSpeech({
    channelId: connected ? channelId : null,
    selfPubkey,
    audioPeerPubkeys,
    snapshot: ephemeralMembers,
    voiceOverride: prefs.voice,
  });
  const agentRoster = useHuddleAgentRoster({
    ephemeralChannelId: connected ? channelId : null,
    parentChannelId: connected ? parentChannelId : null,
    ephemeral: ephemeralMembers,
    parent: parentMembers,
  });

  // Voice mode publishes each gated final as an ordinary message on the
  // huddle channel, mentioning the agents in the room — the p tags ARE the
  // wake. The door (lib/voicePublish.ts) refuses an empty mention set and
  // holds a final until a just-added agent is in the snapshot.
  const agentPubkeys = agentRoster.agentPubkeys;
  const agentPubkeysRef = useRef(agentPubkeys);
  agentPubkeysRef.current = agentPubkeys;
  const freshAddsRef = useRef(new Set<string>());
  const addAgent = useCallback(
    async (input: {
      agentPubkey: string;
      agentName: string;
      alreadyParentMember?: boolean;
      retryRateLimited?: boolean;
      shouldContinue?: () => boolean;
    }) => {
      const result = await agentRoster.addAgent(input);
      if (result.ok) {
        freshAddsRef.current.add(input.agentPubkey.toLowerCase());
      }
      return result;
    },
    [agentRoster.addAgent],
  );
  const publishTranscript = useCallback(
    (text: string) => {
      void publishVoiceFinal(text, {
        currentMentions: () => agentPubkeysRef.current,
        currentFreshAdds: () => [...freshAddsRef.current],
        onFreshAddIncluded: (pubkey) => freshAddsRef.current.delete(pubkey),
        send,
        toastError: (message, toastOptions) =>
          toast.error(message, toastOptions),
      });
    },
    [send],
  );
  const voice = useHuddleVoiceMode({
    channelId: connected ? channelId : null,
    onFinalTranscript: publishTranscript,
    subscribeMicFrames: huddle.subscribeMicFrames,
    micLive: huddle.micLive,
    avatarSpeaking: speech.speaking,
    avatarActivity: speech.speechActivity,
  });

  // ── The duplex gate (S5) ────────────────────────────────────────────────
  // A ref plus mirrored state: the gate must answer in the same task an
  // event lands (an interrupt cannot wait for a render), while the dock
  // needs a rendered view of the hold.
  const gateRef = useRef<DuplexState>(initialDuplexState(prefs.duplex));
  const [gateState, setGateState] = useState<DuplexState>(gateRef.current);
  const interruptRef = useRef(speech.interrupt);
  interruptRef.current = speech.interrupt;
  const dispatchDuplex = useCallback((event: DuplexEvent) => {
    const step = nextMicHold(gateRef.current, event);
    if (step.state !== gateRef.current) {
      gateRef.current = step.state;
      setGateState(step.state);
    }
    if (step.interrupt) {
      interruptRef.current();
    }
  }, []);

  useEffect(() => {
    dispatchDuplex({ type: "set_mode", mode: prefs.duplex });
  }, [prefs.duplex, dispatchDuplex]);
  useEffect(() => {
    dispatchDuplex({ type: "user_mute", muted: huddle.muted });
  }, [huddle.muted, dispatchDuplex]);
  useEffect(() => {
    dispatchDuplex({
      type: "mic_level",
      speaking: isSpeaking(huddle.micLevel),
      at: Date.now(),
    });
  }, [huddle.micLevel, dispatchDuplex]);
  // Interims are the ONLY barge-in trigger: a final that is an echo of the
  // agent is caught downstream by the echo suppressor, and letting one
  // interrupt would let her interrupt herself on speakers.
  useEffect(() => {
    if (voice.interimText !== "") {
      dispatchDuplex({
        type: "interim",
        text: voice.interimText,
        at: Date.now(),
      });
    }
  }, [voice.interimText, dispatchDuplex]);
  // Speech start is immediate; speech END waits one echo tail, because the
  // mic is still hearing the tail of her sentence out of the speakers. The
  // same window the transcript echo-suppressor uses, for the same reason.
  useEffect(() => {
    if (speech.speaking) {
      dispatchDuplex({ type: "agent_speech_start" });
      return;
    }
    const timer = window.setTimeout(
      () => dispatchDuplex({ type: "agent_speech_end" }),
      ECHO_TAIL_MS,
    );
    return () => window.clearTimeout(timer);
  }, [speech.speaking, dispatchDuplex]);
  // The gate's verdict reaches the mic here — and ONLY here, so the user's
  // own mute is never written by it.
  const setHeld = huddle.setHeld;
  useEffect(() => {
    setHeld(gateState.held);
  }, [gateState.held, setHeld]);
  useEffect(() => {
    if (!connected) {
      dispatchDuplex({ type: "reset" });
    }
  }, [connected, dispatchDuplex]);

  // One speaker button, both sources: the room's gain and the agent's.
  const speechSetMuted = speech.setMuted;
  const speechSetOutputDevice = speech.setOutputDevice;
  useEffect(() => {
    speechSetMuted(huddle.speakerMuted);
  }, [huddle.speakerMuted, speechSetMuted]);
  useEffect(() => {
    speechSetOutputDevice(huddle.outputDeviceId);
  }, [huddle.outputDeviceId, speechSetOutputDevice]);

  // ── Voice / reading coupling and persistence (moved from HuddleBar) ─────
  const speechEnabled = speech.enabled;
  const speechSetEnabled = speech.setEnabled;
  const voiceSetEnabledRaw = voice.setEnabled;
  const speechBeforeVoiceRef = useRef<boolean | null>(null);
  const speechUserToggledRef = useRef(false);
  const setReadAgentReplies = useCallback(
    (on: boolean) => {
      speechUserToggledRef.current = true;
      const store = voiceStore();
      if (store && channelId !== null) {
        if (on || voice.enabled) {
          saveHuddleVoiceState(store, channelId, {
            voiceMode: voice.enabled,
            readAgentReplies: on,
          });
        } else {
          clearHuddleVoiceState(store, channelId);
        }
      }
      speechSetEnabled(on);
    },
    [speechSetEnabled, voice.enabled, channelId],
  );
  const setVoiceMode = useCallback(
    (on: boolean) => {
      const store = voiceStore();
      if (store && channelId !== null) {
        // Persist the state the toggle LEAVES the call in: on forces reading
        // on; off restores the pre-voice snapshot unless the user explicitly
        // toggled reading during voice, which outranks it.
        const readAgentReplies = on
          ? true
          : speechUserToggledRef.current
            ? speechEnabled
            : (speechBeforeVoiceRef.current ?? speechEnabled);
        if (on || readAgentReplies) {
          saveHuddleVoiceState(store, channelId, {
            voiceMode: on,
            readAgentReplies,
          });
        } else {
          clearHuddleVoiceState(store, channelId);
        }
      }
      voiceSetEnabledRaw(on);
    },
    [voiceSetEnabledRaw, speechEnabled, channelId],
  );
  useEffect(() => {
    if (!speech.supported) {
      return;
    }
    if (voice.enabled) {
      if (speechBeforeVoiceRef.current === null) {
        speechBeforeVoiceRef.current = speechEnabled;
        speechUserToggledRef.current = false;
        if (!speechEnabled) {
          speechSetEnabled(true);
        }
      }
    } else if (speechBeforeVoiceRef.current !== null) {
      const restore = speechBeforeVoiceRef.current;
      speechBeforeVoiceRef.current = null;
      const userToggled = speechUserToggledRef.current;
      speechUserToggledRef.current = false;
      if (
        speechEnabled !== restore &&
        shouldRestoreSpeechOnVoiceOff({
          offReason: voice.offReason,
          userToggledSpeechDuringVoice: userToggled,
        })
      ) {
        speechSetEnabled(restore);
      }
    }
  }, [
    voice.enabled,
    voice.offReason,
    speechEnabled,
    speechSetEnabled,
    speech.supported,
  ]);

  // A forced latch-off must be unmissable, not a span a busy room scrolls
  // past: toast once per drop, naming what still works.
  const prevVoiceEnabledRef = useRef(false);
  useEffect(() => {
    const wasEnabled = prevVoiceEnabledRef.current;
    prevVoiceEnabledRef.current = voice.enabled;
    if (
      wasEnabled &&
      !voice.enabled &&
      (voice.offReason === "bridge_error" ||
        voice.offReason === "reconnect_cap")
    ) {
      toast.error(voice.error ?? "Voice mode dropped.", {
        description: "Agent reading is unchanged.",
      });
    }
  }, [voice.enabled, voice.offReason, voice.error]);

  // Armed voice state survives a reload, visibly: on the FIRST connected
  // edge of a call, apply what a previous page session saved. Restore is
  // never silent and never masquerades as a fresh user gesture — the borrow
  // snapshot is pre-seeded so the voice-on coupling cannot force reading on
  // over an explicitly-off reader (the SILENT DISARM class).
  const voiceRestoredForRef = useRef<string | null>(null);
  useEffect(() => {
    const store = voiceStore();
    if (!connected || channelId === null || store === null) {
      return;
    }
    if (voiceRestoredForRef.current === channelId) {
      return;
    }
    voiceRestoredForRef.current = channelId;
    const saved = loadHuddleVoiceState(store, channelId);
    if (!saved || (!saved.voiceMode && !saved.readAgentReplies)) {
      return;
    }
    const applyReading = saved.readAgentReplies && speech.supported;
    if (saved.voiceMode && !voice.enabled) {
      speechBeforeVoiceRef.current = applyReading;
      speechUserToggledRef.current = true;
      if (speech.supported) {
        speechSetEnabled(applyReading);
      }
      voiceSetEnabledRaw(true);
    } else if (!saved.voiceMode && applyReading && !speech.enabled) {
      speechSetEnabled(true);
    }
    const announcement = voiceRestoreAnnouncement({
      voiceMode: saved.voiceMode,
      readAgentReplies: applyReading,
    });
    if (announcement) {
      toast.success(announcement.title, {
        description: announcement.description,
      });
    }
  }, [
    connected,
    channelId,
    voice.enabled,
    voiceSetEnabledRaw,
    speech.supported,
    speech.enabled,
    speechSetEnabled,
  ]);

  /**
   * An explicit Leave is a disarm: the user chose to end the call, so the
   * armed state must not come back after a reload of a room they walked out
   * of. (A reload mid-call never reaches this — it is not a click.)
   */
  const leave = useCallback(() => {
    const store = voiceStore();
    if (store && channelId !== null) {
      clearHuddleVoiceState(store, channelId);
    }
    voiceRestoredForRef.current = null;
    huddle.leave();
  }, [huddle.leave, channelId]);

  /** Whoever is speaking right now, for the mic-hold notice. */
  const speakingAgentName = useMemo(() => {
    const first = agentPubkeys[0];
    return first ? authorLabel(first, profiles) : "the agent";
  }, [agentPubkeys, profiles]);

  return {
    channelId,
    parentChannelId,
    connected,
    reconnecting: huddle.status === "reconnecting",
    huddle,
    voice: useMemo(
      () => ({ ...voice, setEnabled: setVoiceMode }),
      [voice, setVoiceMode],
    ),
    speech: useMemo(
      () => ({ ...speech, setEnabled: setReadAgentReplies }),
      [speech, setReadAgentReplies],
    ),
    reactions,
    agentPubkeys,
    addAgent,
    profiles,
    prefs,
    setPrefs,
    duplex: gateState,
    micHoldNotice: micHoldNotice(gateState, speakingAgentName),
    leave,
    send,
    selfPubkey,
  };
}
