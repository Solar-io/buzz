import { useCallback, useEffect, useMemo, useRef } from "react";
import { Mic, MicOff } from "lucide-react";
import { toast } from "sonner";
import { useProfiles } from "@/features/channels/hooks";
import {
  AuthorAvatar,
  authorLabel,
} from "@/features/channels/ui/ChannelTimeline";
import type {
  MessageSendOptions,
  MessageSendResult,
} from "@/features/channels/lib/useMessageActions";
import { useCustomEmoji } from "@/features/custom-emoji/hooks";
import { reactionEmojiUrl } from "@/features/custom-emoji/lib/customEmoji.ts";
import { cn } from "@/shared/lib/cn";
import { truncatePubkey } from "@/shared/lib/pubkey";
import {
  clearHuddleVoiceState,
  loadHuddleVoiceState,
  saveHuddleVoiceState,
  voiceRestoreAnnouncement,
  VOICE_RESTORE_FAILED,
  type VoiceStateStore,
} from "../lib/huddleVoicePersistence.ts";
import { huddleJoinGate } from "../lib/huddleJoinGate.ts";
import { isSpeaking } from "../lib/micMeter.ts";
import { shouldRestoreSpeechOnVoiceOff } from "../lib/voiceTranscript.ts";
import { useHuddleAgentRoster } from "../useHuddleAgentRoster";
import { useHuddleAgentSpeech } from "../useHuddleAgentSpeech";
import { useHuddleAudio } from "../useHuddleAudio";
import { useHuddleMemberSnapshot } from "../useHuddleMemberSnapshot";
import { useHuddleParentFallback } from "../useHuddleParentFallback";
import { useHuddleReactions } from "../useHuddleReactions";
import { useHuddleVoiceMode } from "../useHuddleVoiceMode";
import { HuddleCallControls } from "./HuddleCallControls.tsx";
import { HuddleReactionBurst } from "./HuddleReactionBurst.tsx";
import { MicMeter } from "./MicMeter.tsx";

/** The browser store the armed voice state persists to (injected for tests). */
const voiceStateStore: VoiceStateStore | null =
  typeof window !== "undefined" && window.sessionStorage
    ? window.sessionStorage
    : null;

/**
 * Join/leave bar for huddle channels (ttl channels). Voice rides the relay's
 * huddle audio WebSocket; browsers without WebCodecs audio get a clear
 * fallback message instead of a broken call.
 *
 * Beyond join/leave it now carries the controls the desktop's `MicControls`
 * has: a live input meter, an input-device picker, open-mic vs push-to-talk,
 * and a mute that disables the TRACK rather than only dropping frames.
 *
 * Push-to-talk holds on the button, and on Space while this bar has focus.
 * A GLOBAL push-to-talk hotkey — the desktop's, bound through Tauri — is not
 * implementable in a browser at all: a page cannot observe keystrokes it
 * does not have focus for.
 *
 * Once connected it also carries the desktop's in-call affordances: emoji
 * reactions (kind 24810), adding an agent (kind 9000, role `bot`), agent
 * speech, and voice mode. Speech is the one that is NOT at parity and says
 * so: the browser synthesizes locally for the viewer, where the desktop
 * broadcasts pocket-tts audio into the room as the agent — see
 * `lib/huddleAgentSpeech.ts` for why a browser cannot do the second.
 *
 * Voice mode (`useHuddleVoiceMode`) closes the other direction: the
 * viewer's SPEECH becomes channel messages, recognized by the server-side
 * STT bridge from the same mic frames the huddle uplink captures — so a
 * muted mic or an unheld push-to-talk publishes nothing. Finals publish
 * through `send` — the same path the huddle's chat composer uses, signed
 * by the viewer — with the huddle's agents as `mentionPubkeys`, because a
 * default-config agent only receives channel messages that p-tag it (see
 * `lib/voiceTranscript.ts` for the wire evidence). Finals that arrive
 * while the avatar is speaking are held and echo-checked against her
 * recent utterances (she is read aloud locally, and on speakers the mic
 * hears her too) before publishing. Turning voice on also
 * forces agent speech on for the duration (the toggle is the user gesture
 * `speechSynthesis` needs); turning it off restores whatever speech state
 * preceded it — but ONLY when the user turned it off. A forced drop
 * (bridge error, reconnect cap) restores nothing and toasts, so an armed
 * reader is never silently disarmed (the SILENT DISARM class,
 * `shouldRestoreSpeechOnVoiceOff`).
 *
 * All of these are gated on `connected` rather than on merely viewing the
 * channel. Publishing to a huddle channel needs membership of it, and joining
 * the audio room is what the relay auto-admits parent members through; a
 * control that is present but rejected by the relay is worse than one that
 * appears when it works.
 *
 * Reload survival (VOICE_E2E_2026-09-17 V1b/V2): the parent link is
 * re-resolved from the wire on a cold load — ambient registry first, then a
 * targeted query against the huddle's own kind-48106 guidelines — so a
 * reload can rejoin; an ended huddle renders no live Join; and the armed
 * voice state (voice mode, agent reading) persists in sessionStorage and is
 * restored with a toast on rejoin. See `lib/huddleJoinGate.ts` and
 * `lib/huddleVoicePersistence.ts`.
 */
export function HuddleBar({
  channelId,
  parentChannelId,
  huddleEnded = false,
  huddleLinksResolved = false,
  selfPubkey,
  send,
}: {
  channelId: string;
  /** Linked parent channel — required by the audio room for ephemeral joins. */
  parentChannelId?: string | null;
  /**
   * The relay has retired this huddle: a kind-48103 was seen (live or in
   * the replay) or the backing channel's kind-39000 says archived. A dead
   * huddle renders no live Join at all — an enabled Join on an ended room
   * was the V1b dead-join defect (VOICE_E2E_2026-09-17).
   */
  huddleEnded?: boolean;
  /**
   * The ambient registry feed has replayed at least once (every chunk REQ
   * EOSE'd). The unlinked verdict waits for this AND the targeted query,
   * so a slow replay cannot flash a false "no parent link" before its
   * 48100 lands.
   */
  huddleLinksResolved?: boolean;
  selfPubkey: string | null;
  /**
   * The channel's ordinary message send — the same function the composer
   * under this timeline uses. Voice transcripts ride it so they are signed,
   * threaded and counted exactly like typed messages.
   */
  send: (options: MessageSendOptions) => Promise<MessageSendResult>;
}) {
  // Cold-load parent resolution: when the ambient registry has not handed
  // us the link, ask the relay directly — the huddle's own kind-48106
  // guidelines name the parent (useHuddleParentFallback for why). The
  // merged id is what the audio auth presents, so a reload that lost the
  // sidebar context can still rejoin a live room instead of being gated
  // out with a false "needs a permanent channel" message.
  const fallback = useHuddleParentFallback({
    channelId,
    enabled: !huddleEnded && !parentChannelId,
  });
  const resolvedParentId = parentChannelId ?? fallback.parentId ?? null;
  const gate = huddleJoinGate({
    parentChannelId: resolvedParentId,
    huddleEnded,
    resolutionSettled: fallback.done && huddleLinksResolved,
  });
  const huddle = useHuddleAudio(channelId, resolvedParentId);
  const pubkeys = useMemo(
    () => huddle.peers.map((peer) => peer.pubkey).concat(selfPubkey ?? []),
    [huddle.peers, selfPubkey],
  );
  const profiles = useProfiles(pubkeys);

  // "reconnecting" keeps the in-call controls mounted (the mic graph is
  // alive and the socket is redialing); the chip below is the only visual
  // difference — the call must not flip back to the join screen over a
  // hiccup the client is actively recovering from.
  const connected =
    huddle.status === "connected" || huddle.status === "reconnecting";
  const reconnecting = huddle.status === "reconnecting";
  const pushToTalk = huddle.voiceInputMode === "push_to_talk";
  const { setPushToTalkActive } = huddle;

  // The three in-call features hang off the SAME ephemeral channel the audio
  // room uses, so they need no extra wiring from the route — `channelId` here
  // already is the huddle's backing channel, and `parentChannelId` its link.
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
  // ONE poller per channel, shared by the speech gate and the agent roster.
  // Two pollers on the same channel doubled the REQ/CLOSE churn and could
  // trip the relay's per-second write quota alongside a publish.
  const ephemeralMembers = useHuddleMemberSnapshot(
    connected ? channelId : null,
  );
  const parentMembers = useHuddleMemberSnapshot(
    connected ? resolvedParentId : null,
  );
  const speech = useHuddleAgentSpeech({
    channelId: connected ? channelId : null,
    selfPubkey,
    audioPeerPubkeys,
    snapshot: ephemeralMembers,
  });
  const agentRoster = useHuddleAgentRoster({
    ephemeralChannelId: connected ? channelId : null,
    parentChannelId: connected ? resolvedParentId : null,
    ephemeral: ephemeralMembers,
    parent: parentMembers,
  });

  // Voice mode: publish each gated final transcript as an ordinary message
  // on this huddle channel, mentioning the agents in the room. The p tags
  // ARE the wake — a default-config agent's subscription filters on #p, so
  // an untagged transcript never reaches it (lib/voiceTranscript.ts header).
  // threadRef null = top-level, matching the desktop's STT publishes.
  const agentPubkeys = agentRoster.agentPubkeys;
  const publishTranscript = useCallback(
    (text: string) => {
      void send({
        content: text,
        mentionPubkeys: agentPubkeys,
        threadRef: null,
        mediaTags: [],
      }).then((result) => {
        if (!result.ok) {
          // Speech that vanishes with no feedback reads as "it ignored me".
          toast.error(result.message || "The transcript could not be sent.");
        }
      });
    },
    [send, agentPubkeys],
  );
  const voice = useHuddleVoiceMode({
    channelId: connected ? channelId : null,
    onFinalTranscript: publishTranscript,
    subscribeMicFrames: huddle.subscribeMicFrames,
    micLive: huddle.micLive,
    // Echo suppression: the avatar's local speechSynthesis voice comes out
    // of the speakers into the same mic, so voice mode holds finals that
    // land while she speaks (or just after) and drops the ones that match
    // her own words — see lib/voiceTranscript.ts.
    avatarSpeaking: speech.speaking,
    avatarActivity: speech.speechActivity,
  });

  // Voice ON also enables agent speech — the toggle is the user gesture
  // speechSynthesis is gated on. Voice OFF restores the speech state that
  // preceded it ONLY on a deliberate off: a forced drop (bridge error,
  // reconnect cap, leaving) restores nothing, and an explicit speech
  // toggle made during voice mode outranks the pre-voice snapshot — the
  // SILENT DISARM class (2026-09-16 e2e: a latched-off voice toggle
  // silently reverted an armed reader while the room looked healthy).
  const speechEnabled = speech.enabled;
  const speechSetEnabled = speech.setEnabled;
  const voiceSetEnabledRaw = voice.setEnabled;
  const speechBeforeVoiceRef = useRef<boolean | null>(null);
  const speechUserToggledRef = useRef(false);
  // Controls get a wrapped setEnabled so an explicit press on "Read agent
  // replies" is distinguishable from the borrowed on this component forces
  // at voice start. The coupling effect above deliberately calls the RAW
  // setter — its own writes are not user choices. The wrappers also persist
  // the armed state (reload survival): an explicit choice is exactly what
  // should come back after a reload, and a forced drop or a restore must
  // never masquerade as one.
  const speechSetEnabledFromControls = useCallback(
    (on: boolean) => {
      speechUserToggledRef.current = true;
      if (voiceStateStore) {
        if (on || voice.enabled) {
          saveHuddleVoiceState(voiceStateStore, channelId, {
            voiceMode: voice.enabled,
            readAgentReplies: on,
          });
        } else {
          clearHuddleVoiceState(voiceStateStore, channelId);
        }
      }
      speechSetEnabled(on);
    },
    [speechSetEnabled, voice.enabled, channelId],
  );
  const speechForControls = useMemo(
    () => ({ ...speech, setEnabled: speechSetEnabledFromControls }),
    [speech, speechSetEnabledFromControls],
  );
  const voiceSetEnabledFromControls = useCallback(
    (on: boolean) => {
      if (voiceStateStore) {
        // Persist the state the toggle LEAVES the call in, not the moment's
        // raw flag: on forces reading on (the coupling below); off restores
        // the pre-voice snapshot — UNLESS the user explicitly toggled
        // reading during voice, which outranks the snapshot (the same rule
        // the off-restore path applies).
        const readAgentReplies = on
          ? true
          : speechUserToggledRef.current
            ? speechEnabled
            : (speechBeforeVoiceRef.current ?? speechEnabled);
        if (on || readAgentReplies) {
          saveHuddleVoiceState(voiceStateStore, channelId, {
            voiceMode: on,
            readAgentReplies,
          });
        } else {
          clearHuddleVoiceState(voiceStateStore, channelId);
        }
      }
      voiceSetEnabledRaw(on);
    },
    [voiceSetEnabledRaw, speechEnabled, channelId],
  );
  const voiceForControls = useMemo(
    () => ({ ...voice, setEnabled: voiceSetEnabledFromControls }),
    [voice, voiceSetEnabledFromControls],
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

  // A forced latch-off must be unmissable, not a text-2xs span a busy room
  // can scroll past: toast once per drop, naming what still works.
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

  // V2 — armed voice state survives a reload, visibly. The entry in
  // sessionStorage was written by a previous page session (explicit
  // disarm and Leave clear it), so on the FIRST connected edge of this
  // mount, apply it: voice mode, agent reading, both, or the saved-off
  // states. Restore is never silent — the toast names what came back —
  // and never masquerades as a fresh user gesture: the borrow snapshot is
  // pre-seeded so the voice-on coupling cannot force reading on over an
  // explicitly-off reader (the SILENT DISARM class again).
  const voiceRestoredRef = useRef(false);
  useEffect(() => {
    if (!connected || voiceRestoredRef.current || !voiceStateStore) {
      return;
    }
    voiceRestoredRef.current = true;
    const saved = loadHuddleVoiceState(voiceStateStore, channelId);
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

  // The honest failure leg of the same contract: if this huddle is dead,
  // there is no rejoin that could bring the armed state back, so say so
  // once — and stop offering to restore it. Pretending otherwise (or
  // dropping the state with no signal) is the silent failure the reload
  // work exists to kill.
  const failedRestoreSurfacedRef = useRef(false);
  useEffect(() => {
    if (
      !huddleEnded ||
      connected ||
      failedRestoreSurfacedRef.current ||
      !voiceStateStore
    ) {
      return;
    }
    const saved = loadHuddleVoiceState(voiceStateStore, channelId);
    if (!saved || (!saved.voiceMode && !saved.readAgentReplies)) {
      return;
    }
    failedRestoreSurfacedRef.current = true;
    clearHuddleVoiceState(voiceStateStore, channelId);
    toast.error(VOICE_RESTORE_FAILED.title, {
      description: VOICE_RESTORE_FAILED.description,
    });
  }, [huddleEnded, connected, channelId]);

  // An explicit Leave is a disarm: the user chose to end the call, so the
  // armed state must not come back after a reload of a room they walked
  // out of. (A reload mid-call never reaches this — it is not a click.)
  const leaveFromControls = useCallback(() => {
    if (voiceStateStore) {
      clearHuddleVoiceState(voiceStateStore, channelId);
    }
    huddle.leave();
  }, [huddle.leave, channelId]);

  // Space holds the mic open while the bar has focus. Bound on the bar, not
  // the document, so it cannot swallow the space bar out of a composer.
  useEffect(() => {
    if (!connected || !pushToTalk) {
      return;
    }
    // A blur mid-hold must release, or the mic latches open behind a
    // window the user has already left.
    const release = () => setPushToTalkActive(false);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("blur", release);
      release();
    };
  }, [connected, pushToTalk, setPushToTalkActive]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the bar is a key-hold surface for push-to-talk, not a control in its own right
    <div
      className="relative flex flex-wrap items-center gap-3 border-b border-border bg-card/40 px-4 py-2 outline-none"
      onPointerDown={() => {
        // A system-suspended AudioContext can only be resumed from a
        // gesture; every press on the bar is one. No-op while running.
        if (connected) {
          void huddle.resumeAudio();
        }
      }}
      onKeyDown={(event) => {
        if (event.key === " " && connected && pushToTalk && !event.repeat) {
          event.preventDefault();
          setPushToTalkActive(true);
        }
      }}
      onKeyUp={(event) => {
        if (event.key === " " && connected && pushToTalk) {
          event.preventDefault();
          setPushToTalkActive(false);
        }
      }}
    >
      {connected ? (
        <>
          <HuddleReactionBurst reactions={reactions.active} />
          {reconnecting && (
            <span
              data-testid="huddle-reconnecting"
              className="animate-pulse rounded-full border border-amber-500/50 bg-amber-500/10 px-2 py-0.5 text-2xs text-amber-400"
              role="status"
            >
              Reconnecting…
            </span>
          )}
          {huddle.error && (
            <span className="text-2xs text-red-400" role="alert">
              {huddle.error}
            </span>
          )}
          <button
            type="button"
            data-testid="huddle-mute"
            onClick={huddle.toggleMute}
            className={cn(
              "flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium",
              huddle.muted
                ? "border-border text-muted-foreground"
                : "border-emerald-600/50 bg-emerald-600/20 text-emerald-400",
            )}
            aria-pressed={huddle.muted}
            aria-label={huddle.muted ? "Unmute microphone" : "Mute microphone"}
          >
            {huddle.muted ? (
              <MicOff aria-hidden className="h-3.5 w-3.5" />
            ) : (
              <Mic aria-hidden className="h-3.5 w-3.5" />
            )}
            {huddle.muted ? "Muted" : "Live"}
          </button>
          <MicMeter levelDbov={huddle.micLevel} muted={huddle.muted} />
          {pushToTalk && (
            <button
              type="button"
              data-testid="huddle-ptt"
              aria-pressed={huddle.pttActive}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium select-none",
                huddle.pttActive
                  ? "border-emerald-600/60 bg-emerald-600/25 text-emerald-300"
                  : "border-border text-muted-foreground",
              )}
              onPointerDown={() => setPushToTalkActive(true)}
              onPointerUp={() => setPushToTalkActive(false)}
              onPointerLeave={() => setPushToTalkActive(false)}
            >
              {huddle.pttActive ? "Talking…" : "Hold to talk"}
            </button>
          )}
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            <span className="sr-only">Voice input mode</span>
            <select
              data-testid="huddle-input-mode"
              className="rounded border border-border bg-transparent px-1 py-0.5 text-xs"
              value={huddle.voiceInputMode}
              onChange={(event) =>
                huddle.setVoiceInputMode(
                  event.target.value as typeof huddle.voiceInputMode,
                )
              }
            >
              <option value="open">Open mic</option>
              <option value="push_to_talk">Push to talk</option>
            </select>
          </label>
          <HuddleCallControls
            agentPubkeys={agentRoster.agentPubkeys}
            onAddAgent={agentRoster.addAgent}
            onReact={reactions.send}
            reactionError={reactions.error}
            speech={speechForControls}
            voice={voiceForControls}
          />
          {voice.enabled && voice.interimText && (
            <span
              data-testid="huddle-voice-interim"
              className="min-w-0 max-w-56 truncate text-xs italic text-muted-foreground/70"
              title={voice.interimText}
            >
              {voice.interimText}
            </span>
          )}
          {voice.error && (
            <span className="text-2xs text-red-400" role="alert">
              {voice.error}
            </span>
          )}
          <button
            type="button"
            onClick={leaveFromControls}
            className="rounded-full border border-red-500/40 px-3 py-1 text-xs font-medium text-red-400 hover:bg-red-500/10"
          >
            Leave
          </button>
          <div className="flex flex-wrap items-center gap-1.5">
            {huddle.peers.map((peer) => {
              const level = huddle.speaking.get(peer.pubkey) ?? -127;
              const talking = isSpeaking(level);
              return (
                <span
                  key={peer.pubkey}
                  data-testid="huddle-peer"
                  data-speaking={talking ? "true" : "false"}
                  className={cn(
                    "flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs",
                    talking
                      ? "border-emerald-500/60 bg-emerald-500/10 text-emerald-400"
                      : "border-border text-muted-foreground",
                  )}
                  title={`${authorLabel(peer.pubkey, profiles)} ${level} dBov`}
                >
                  <AuthorAvatar
                    pubkey={peer.pubkey}
                    label={authorLabel(peer.pubkey, profiles)}
                    picture={profiles.get(peer.pubkey)?.avatar}
                    size="sm"
                  />
                  {authorLabel(peer.pubkey, profiles)}
                </span>
              );
            })}
          </div>
        </>
      ) : (
        <>
          {/* Join gating is the join gate's three states, not one blunt
              rule. The relay denies audio auth on an ephemeral channel with
              no parent link ("ephemeral channel requires parent linkage",
              crates/buzz-relay/src/audio/handler.rs), so a genuinely
              unlinked room is disabled WITH that reason; a room whose
              linkage query is still in flight shows no failure reason; and
              an ENDED huddle renders no Join at all — an enabled Join that
              dead-ends against the relay's "channel is archived" refusal
              was the V1b dead-join defect. */}
          {gate.state === "ended" ? (
            <span
              data-testid="huddle-ended"
              role="status"
              className="rounded-full border border-red-500/40 bg-red-500/10 px-3 py-1 text-xs font-medium text-red-400"
            >
              {gate.reason}
            </span>
          ) : (
            <button
              type="button"
              data-testid="huddle-join-audio"
              onClick={() => void huddle.join()}
              disabled={
                huddle.status === "connecting" ||
                !huddle.supportsVoice ||
                !gate.joinable
              }
              title={gate.reason ?? gate.hint ?? undefined}
              className="rounded-full border border-emerald-600/50 bg-emerald-600/20 px-3 py-1 text-xs font-medium text-emerald-400 disabled:opacity-50"
            >
              {huddle.status === "connecting" ? "Joining…" : "🎧 Join huddle"}
            </button>
          )}
          {huddle.devices.length > 1 && (
            <label className="flex items-center gap-1 text-xs text-muted-foreground">
              <span className="sr-only">Microphone</span>
              <select
                data-testid="huddle-device"
                className="max-w-48 truncate rounded border border-border bg-transparent px-1 py-0.5 text-xs"
                value={huddle.deviceId}
                onChange={(event) => huddle.selectDevice(event.target.value)}
              >
                <option value="">System default</option>
                {huddle.devices.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {selfPubkey && (
            <span className="text-xs text-muted-foreground">
              you: {truncatePubkey(selfPubkey)}
            </span>
          )}
          {huddle.error && (
            <span className="text-xs text-red-400" role="alert">
              {huddle.error}
            </span>
          )}
          {!huddle.supportsVoice && (
            <span className="text-xs text-amber-400">
              Voice needs a browser with WebCodecs audio (Chrome, Edge, recent
              Safari) — you can still listen and type here.
            </span>
          )}
        </>
      )}
    </div>
  );
}
