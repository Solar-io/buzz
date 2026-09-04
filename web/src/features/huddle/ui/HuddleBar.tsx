import { useEffect, useMemo } from "react";
import { Mic, MicOff } from "lucide-react";
import { useProfiles } from "@/features/channels/hooks";
import {
  AuthorAvatar,
  authorLabel,
} from "@/features/channels/ui/ChannelTimeline";
import { cn } from "@/shared/lib/cn";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { isSpeaking } from "../lib/micMeter.ts";
import { useHuddleAudio } from "../useHuddleAudio";
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
 */
export function HuddleBar({
  channelId,
  parentChannelId,
  selfPubkey,
}: {
  channelId: string;
  /** Linked parent channel — required by the audio room for ephemeral joins. */
  parentChannelId?: string | null;
  selfPubkey: string | null;
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
      className="flex flex-wrap items-center gap-3 border-b border-border bg-card/40 px-4 py-2 outline-none"
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
