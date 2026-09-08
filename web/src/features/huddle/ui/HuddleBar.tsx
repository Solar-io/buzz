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
import { isSpeaking } from "../lib/micMeter.ts";
import { useHuddleAgentRoster } from "../useHuddleAgentRoster";
import { useHuddleAgentSpeech } from "../useHuddleAgentSpeech";
import { useHuddleAudio } from "../useHuddleAudio";
import { useHuddleMemberSnapshot } from "../useHuddleMemberSnapshot";
import { useHuddleReactions } from "../useHuddleReactions";
import { useHuddleVoiceMode } from "../useHuddleVoiceMode";
import { HuddleCallControls } from "./HuddleCallControls.tsx";
import { HuddleReactionBurst } from "./HuddleReactionBurst.tsx";
import { MicMeter } from "./MicMeter.tsx";

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
 * `lib/voiceTranscript.ts` for the wire evidence). Turning voice on also
 * forces agent speech on for the duration (the toggle is the user gesture
 * `speechSynthesis` needs); turning it off restores whatever speech state
 * preceded it.
 *
 * All of these are gated on `connected` rather than on merely viewing the
 * channel. Publishing to a huddle channel needs membership of it, and joining
 * the audio room is what the relay auto-admits parent members through; a
 * control that is present but rejected by the relay is worse than one that
 * appears when it works.
 */
export function HuddleBar({
  channelId,
  parentChannelId,
  selfPubkey,
  send,
}: {
  channelId: string;
  /** Linked parent channel — required by the audio room for ephemeral joins. */
  parentChannelId?: string | null;
  selfPubkey: string | null;
  /**
   * The channel's ordinary message send — the same function the composer
   * under this timeline uses. Voice transcripts ride it so they are signed,
   * threaded and counted exactly like typed messages.
   */
  send: (options: MessageSendOptions) => Promise<MessageSendResult>;
}) {
  const huddle = useHuddleAudio(channelId, parentChannelId);
  const pubkeys = useMemo(
    () => huddle.peers.map((peer) => peer.pubkey).concat(selfPubkey ?? []),
    [huddle.peers, selfPubkey],
  );
  const profiles = useProfiles(pubkeys);

  const connected = huddle.status === "connected";
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
    connected ? (parentChannelId ?? null) : null,
  );
  const speech = useHuddleAgentSpeech({
    channelId: connected ? channelId : null,
    selfPubkey,
    audioPeerPubkeys,
    snapshot: ephemeralMembers,
  });
  const agentRoster = useHuddleAgentRoster({
    ephemeralChannelId: connected ? channelId : null,
    parentChannelId: connected ? (parentChannelId ?? null) : null,
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
  });

  // Voice ON also enables agent speech — the toggle is the user gesture
  // speechSynthesis is gated on. Voice OFF restores the speech state that
  // preceded it (its prior default), which is "off" unless the user had
  // read-aloud on before speaking.
  const speechEnabled = speech.enabled;
  const speechSetEnabled = speech.setEnabled;
  const speechBeforeVoiceRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (!speech.supported) {
      return;
    }
    if (voice.enabled) {
      if (speechBeforeVoiceRef.current === null) {
        speechBeforeVoiceRef.current = speechEnabled;
        if (!speechEnabled) {
          speechSetEnabled(true);
        }
      }
    } else if (speechBeforeVoiceRef.current !== null) {
      const restore = speechBeforeVoiceRef.current;
      speechBeforeVoiceRef.current = null;
      if (speechEnabled !== restore) {
        speechSetEnabled(restore);
      }
    }
  }, [voice.enabled, speechEnabled, speechSetEnabled, speech.supported]);

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
            speech={speech}
            voice={voice}
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
            onClick={huddle.leave}
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
          <button
            type="button"
            data-testid="huddle-join-audio"
            onClick={() => void huddle.join()}
            disabled={huddle.status === "connecting" || !huddle.supportsVoice}
            className="rounded-full border border-emerald-600/50 bg-emerald-600/20 px-3 py-1 text-xs font-medium text-emerald-400 disabled:opacity-50"
          >
            {huddle.status === "connecting" ? "Joining…" : "🎧 Join huddle"}
          </button>
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
