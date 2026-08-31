import { useMemo } from "react";
import { useProfiles } from "@/features/channels/hooks";
import {
  AuthorAvatar,
  authorLabel,
} from "@/features/channels/ui/ChannelTimeline";
import { cn } from "@/shared/lib/cn";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { useHuddleAudio } from "../useHuddleAudio";

/**
 * Join/leave bar for huddle channels (ttl channels). Voice rides the relay's
 * huddle audio WebSocket; browsers without WebCodecs audio get a clear
 * fallback message instead of a broken call.
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

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-border bg-card/40 px-4 py-2">
      {huddle.status === "connected" ? (
        <>
          <button
            type="button"
            onClick={huddle.toggleMute}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium",
              huddle.muted
                ? "border-border text-muted-foreground"
                : "border-emerald-600/50 bg-emerald-600/20 text-emerald-400",
            )}
            aria-label={huddle.muted ? "Unmute microphone" : "Mute microphone"}
          >
            {huddle.muted ? "🎙 Muted" : "🎙 Live"}
          </button>
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
              const talking = level > -45;
              return (
                <span
                  key={peer.pubkey}
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
            onClick={() => void huddle.join()}
            disabled={huddle.status === "connecting" || !huddle.supportsVoice}
            className="rounded-full border border-emerald-600/50 bg-emerald-600/20 px-3 py-1 text-xs font-medium text-emerald-400 disabled:opacity-50"
          >
            {huddle.status === "connecting" ? "Joining…" : "🎧 Join huddle"}
          </button>
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
