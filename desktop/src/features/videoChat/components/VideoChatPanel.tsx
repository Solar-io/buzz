import { invoke } from "@tauri-apps/api/core";
import { Loader2, Mic, MicOff, PhoneOff, Settings2, Video } from "lucide-react";
import * as React from "react";

import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { cn } from "@/shared/lib/cn";

import { describeAnamError, startAnamSession } from "../lib/anam";
import { useVideoChatConfig } from "../lib/config";

/**
 * The video-chat panel: an Anam-rendered persona whose brain is the Buzz
 * agent on the other side of `channelId`.
 *
 * Opening the panel points the Rust loopback relay at this DM
 * (`video_chat_set_target`) so the Anam custom LLM routes turns through the
 * logged-in owner — the same identity position huddles use. Arming also
 * propagates to configured peer installs, so a panel on aeryn arms the
 * crichton relay Anam's funnel URL reaches. Closing stops the stream and
 * clears the target everywhere.
 */
export function VideoChatPanel(props: {
  channelId: string;
  agentPubkey: string;
  agentName?: string | null;
  onClose: () => void;
}) {
  const { channelId, agentPubkey, agentName, onClose } = props;
  const { config, update } = useVideoChatConfig();
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const audioRef = React.useRef<HTMLAudioElement>(null);
  const clientRef = React.useRef<Awaited<
    ReturnType<typeof startAnamSession>
  > | null>(null);
  const [state, setState] = React.useState<
    "idle" | "connecting" | "live" | "error"
  >("idle");
  const [error, setError] = React.useState<string | null>(null);
  const [micOn, setMicOn] = React.useState(true);
  const [showSettings, setShowSettings] = React.useState(false);
  const [relayToken, setRelayToken] = React.useState<string | null>(null);

  // Refresh the relay token whenever the settings sheet opens, so the
  // copyable token shown for Anam Lab wiring is current.
  React.useEffect(() => {
    if (!showSettings) return;
    void invoke<{ token: string | null }>("video_chat_status")
      .then((s) => setRelayToken(s.token))
      .catch(() => undefined);
  }, [showSettings]);

  // Point the relay at this DM for the lifetime of the panel — and keep
  // re-asserting it. The peer forward to the funnel-side install is
  // fire-and-forget, so an arming that fired while the peer's app was down
  // (restart ordering) used to be lost forever: every call turn then hit
  // "no video-chat target" and Anam silently swapped in its stock brain —
  // the 2026-08-24 stranger-with-her-face call. Re-arming every 20s heals
  // any missed forward within one interval.
  React.useEffect(() => {
    const arm = () =>
      void invoke("video_chat_set_target", {
        channelId,
        agentPubkey,
        agentName: agentName ?? null,
      }).catch((e) => setError(String(e)));
    arm();
    const timer = window.setInterval(arm, 20_000);
    return () => {
      window.clearInterval(timer);
      void invoke("video_chat_clear_target").catch(() => undefined);
    };
  }, [channelId, agentPubkey, agentName]);

  const start = React.useCallback(async () => {
    setError(null);
    setState("connecting");
    // Re-assert the target at the exact moment a call begins — the 20s
    // interval heals stale arming, but Start is the one instant it must
    // already be right.
    await invoke("video_chat_set_target", {
      channelId,
      agentPubkey,
      agentName: agentName ?? null,
    }).catch(() => undefined);
    try {
      const element = videoRef.current;
      const audio = audioRef.current;
      if (!element || !audio) throw new Error("video element not mounted");
      const client = await startAnamSession(config, element, audio);
      clientRef.current = client;
      setState("live");
    } catch (e) {
      setState("error");
      setError(describeAnamError(e));
    }
  }, [config, channelId, agentPubkey, agentName]);

  const stop = React.useCallback(() => {
    void clientRef.current?.stopStreaming?.();
    clientRef.current = null;
    setState("idle");
  }, []);

  React.useEffect(() => {
    return () => {
      void clientRef.current?.stopStreaming?.();
      clientRef.current = null;
    };
  }, []);

  const toggleMic = React.useCallback(() => {
    const next = !micOn;
    setMicOn(next);
    const client = clientRef.current;
    if (!client) return;
    // muteInputAudio/unmuteInputAudio return the new InputAudioState.
    try {
      if (next) client.unmuteInputAudio();
      else client.muteInputAudio();
    } catch {
      // Mic state changes outside a live session are harmless to ignore.
    }
  }, [micOn]);

  const canStart =
    config.anamApiKey.length > 0 &&
    (config.personaId.length > 0 ||
      config.avatarId.length > 0 ||
      config.avatarModel.length > 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6">
      <div className="flex w-full max-w-2xl flex-col gap-4 rounded-xl border bg-background p-4 shadow-2xl">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Video className="size-4" />
            Video chat — {agentName ?? "agent"}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowSettings((v) => !v)}
          >
            <Settings2 className="size-4" />
            Settings
          </Button>
        </div>

        <div className="relative aspect-video overflow-hidden rounded-lg bg-black">
          {/* biome-ignore lint/a11y/useMediaCaption: live-streamed avatar, no static track exists */}
          <video
            ref={videoRef}
            id="buzz-video-chat-persona-video"
            className="size-full"
            autoPlay
            playsInline
          />
          {/* The SDK splits its stream: video track above, audio track here. */}
          {/* biome-ignore lint/a11y/useMediaCaption: live voice chat, no static track exists */}
          <audio
            ref={audioRef}
            id="buzz-video-chat-persona-audio"
            autoPlay
            className="hidden"
          />
          {state !== "live" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
              {state === "connecting" && (
                <>
                  <Loader2 className="size-6 animate-spin" />
                  Connecting…
                </>
              )}
              {state === "idle" && <span>Ready — press Start to call.</span>}
              {state === "error" && (
                <span className="max-w-md text-center">{error}</span>
              )}
            </div>
          )}
        </div>

        {showSettings && (
          <div className="grid gap-2 rounded-lg border p-3 text-sm">
            <p className="text-muted-foreground">
              Anam persona wiring — from Anam Lab. The custom LLM (llmId) is the
              one pointing at this app. Persona ID is the Lab persona's ID —
              when set it overrides Avatar ID / Voice (the persona bundles
              them). A persona ID pasted into Avatar ID starts zero sessions:
              Anam takes it at mint and rejects it at session start.
            </p>
            <SettingsField
              label="Anam API key"
              value={config.anamApiKey}
              onChange={(v) => update({ anamApiKey: v })}
              type="password"
            />
            <SettingsField
              label="Persona ID"
              value={config.personaId}
              onChange={(v) => update({ personaId: v })}
            />
            <SettingsField
              label="Avatar ID"
              value={config.avatarId}
              onChange={(v) => update({ avatarId: v })}
            />
            <SettingsField
              label="Avatar model"
              value={config.avatarModel}
              onChange={(v) => update({ avatarModel: v })}
            />
            <SettingsField
              label="Voice ID"
              value={config.voiceId}
              onChange={(v) => update({ voiceId: v })}
            />
            <SettingsField
              label="Custom LLM ID"
              value={config.llmId}
              onChange={(v) => update({ llmId: v })}
            />
            <div className="mt-1 flex items-center gap-2">
              <span className="w-32 shrink-0 text-muted-foreground">
                Relay token
              </span>
              <code className="flex-1 truncate rounded bg-muted px-2 py-1 text-xs">
                {relayToken ?? "…"}
              </code>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(relayToken ?? "")
                    .catch(() => undefined)
                }
              >
                Copy
              </Button>
            </div>
            <p className="text-muted-foreground">
              Paste the token as the Bearer/auth key on the Anam custom LLM
              whose base URL points at this app (port 6371). It is stable across
              app restarts.
            </p>
          </div>
        )}

        <div className="flex items-center justify-center gap-3">
          {state === "live" ? (
            <>
              <Button variant="outline" size="sm" onClick={toggleMic}>
                {micOn ? (
                  <Mic className="size-4" />
                ) : (
                  <MicOff className="size-4" />
                )}
                {micOn ? "Mute" : "Unmute"}
              </Button>
              <Button variant="destructive" size="sm" onClick={stop}>
                <PhoneOff className="size-4" />
                End
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              disabled={!canStart || state === "connecting"}
              onClick={() => void start()}
            >
              <Video className="size-4" />
              Start call
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}

function SettingsField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the Input below is inside the label; biome can't see through the shared component
    <label className={cn("flex items-center gap-2")}>
      <span className="w-32 shrink-0 text-muted-foreground">{props.label}</span>
      <Input
        type={props.type ?? "text"}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        className="h-8"
      />
    </label>
  );
}
