import {
  AudioLines,
  Bot,
  Maximize2,
  Mic,
  MicOff,
  Minimize2,
  SmilePlus,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useEffect, useState } from "react";

import { EmojiPicker } from "@/features/custom-emoji/ui/EmojiPicker";
import { cn } from "@/shared/lib/cn";
import {
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
} from "@/shared/ui/dropdown-menu";

import { SINK_ID_UNSUPPORTED_MESSAGE } from "../lib/audioDevices.ts";
import { useHuddleSession } from "../HuddleSessionProvider.tsx";
import { AddHuddleAgentDialog } from "./AddHuddleAgentDialog.tsx";
import { HuddleDeviceMenu } from "./HuddleDeviceMenu.tsx";
import {
  HuddleParticipantStack,
  huddleParticipants,
} from "./HuddleParticipants.tsx";
import { HuddleSettingsPopover } from "./HuddleSettingsPopover.tsx";

/**
 * The in-call control row, shared VERBATIM by the dock (S2) and the
 * floating panel (S3).
 *
 * One component rather than two layouts is the point: a dock and a panel
 * that each grew their own mic button is how "mute" ends up meaning two
 * different things depending on where you pressed it.
 *
 * Left to right, matching the screenshots: mic split-button, speaker
 * split-button, participant stack, the centre group (reaction, voice mode,
 * add agent, settings), then float/dock and Leave.
 *
 * Every `data-testid` the old bar carried for a control that still exists is
 * preserved — `huddle-mute`, `huddle-ptt`, `huddle-input-mode`,
 * `huddle-react`, `huddle-voice-mode`, `huddle-agent-speech`,
 * `huddle-add-agent`, `huddle-device` — alongside the new ones.
 */
export function HuddleControls({ variant }: { variant: "dock" | "panel" }) {
  const { call, floating, setFloating } = useHuddleSession();
  const { huddle, voice, speech } = call;
  const [addAgentOpen, setAddAgentOpen] = useState(false);
  const pushToTalk = huddle.voiceInputMode === "push_to_talk";
  const { setPushToTalkActive } = huddle;
  const speaking = speech.enabled && speech.supported;
  const participants = huddleParticipants(call, call.profiles);

  // A blur mid-hold must release, or the mic latches open behind a window
  // the user has already left.
  useEffect(() => {
    if (!pushToTalk) {
      return;
    }
    const release = () => setPushToTalkActive(false);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("blur", release);
      release();
    };
  }, [pushToTalk, setPushToTalkActive]);

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      data-testid={`huddle-controls-${variant}`}
      onPointerDown={() => {
        // A system-suspended AudioContext can only be resumed from a
        // gesture; every press on the row is one. No-op while running.
        void huddle.resumeAudio();
      }}
    >
      {/* ── Mic split-button ─────────────────────────────────────────── */}
      <div className="flex items-center">
        <button
          aria-label={huddle.muted ? "Unmute microphone" : "Mute microphone"}
          aria-pressed={huddle.muted}
          className={cn(
            "flex items-center gap-1.5 rounded-l-full border px-3 py-1 text-xs font-medium",
            huddle.muted
              ? "border-red-500/60 bg-red-500/20 text-red-300"
              : "border-border text-foreground",
          )}
          data-testid="huddle-mute"
          onClick={huddle.toggleMute}
          type="button"
        >
          {huddle.muted ? (
            <MicOff aria-hidden className="h-3.5 w-3.5" />
          ) : (
            <Mic aria-hidden className="h-3.5 w-3.5" />
          )}
          <span className="sr-only">
            {huddle.muted ? "Muted" : "Microphone live"}
          </span>
        </button>
        <HuddleDeviceMenu
          currentDeviceId={huddle.deviceId}
          devices={huddle.devices}
          itemTestId="huddle-device"
          label="Microphone"
          onSelect={(deviceId) => void huddle.selectDevice(deviceId)}
          testId="huddle-mic-menu"
        >
          <DropdownMenuLabel className="text-2xs uppercase tracking-wide">
            Input mode
          </DropdownMenuLabel>
          <DropdownMenuCheckboxItem
            checked={huddle.voiceInputMode === "open"}
            data-testid="huddle-input-mode"
            onSelect={() => huddle.setVoiceInputMode("open")}
          >
            Open mic
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={pushToTalk}
            data-testid="huddle-input-mode"
            onSelect={() => huddle.setVoiceInputMode("push_to_talk")}
          >
            Push to talk
          </DropdownMenuCheckboxItem>
        </HuddleDeviceMenu>
      </div>

      {pushToTalk && (
        <button
          aria-pressed={huddle.pttActive}
          className={cn(
            "select-none rounded-full border px-3 py-1 text-xs font-medium",
            huddle.pttActive
              ? "border-emerald-600/60 bg-emerald-600/25 text-emerald-300"
              : "border-border text-muted-foreground",
          )}
          data-testid="huddle-ptt"
          onPointerDown={() => setPushToTalkActive(true)}
          onPointerLeave={() => setPushToTalkActive(false)}
          onPointerUp={() => setPushToTalkActive(false)}
          type="button"
        >
          {huddle.pttActive ? "Talking…" : "Hold to talk"}
        </button>
      )}

      {/* ── Speaker split-button ─────────────────────────────────────── */}
      <div className="flex items-center">
        <button
          aria-label={huddle.speakerMuted ? "Unmute playback" : "Mute playback"}
          aria-pressed={huddle.speakerMuted}
          className={cn(
            "flex items-center gap-1.5 rounded-l-full border px-3 py-1 text-xs font-medium",
            huddle.speakerMuted
              ? "border-red-500/60 bg-red-500/20 text-red-300"
              : "border-border text-foreground",
          )}
          data-testid="huddle-speaker"
          onClick={huddle.toggleSpeakerMuted}
          type="button"
        >
          {huddle.speakerMuted ? (
            <VolumeX aria-hidden className="h-3.5 w-3.5" />
          ) : (
            <Volume2 aria-hidden className="h-3.5 w-3.5" />
          )}
        </button>
        <HuddleDeviceMenu
          currentDeviceId={huddle.outputDeviceId}
          devices={huddle.outputDevices}
          disabled={!huddle.supportsOutputSelection}
          disabledReason={SINK_ID_UNSUPPORTED_MESSAGE}
          itemTestId="huddle-speaker-device"
          label="Speaker"
          onSelect={(deviceId) => void huddle.selectOutputDevice(deviceId)}
          testId="huddle-speaker-menu"
        />
      </div>

      <HuddleParticipantStack participants={participants} />

      {/* ── Centre group ────────────────────────────────────────────── */}
      <div className="flex items-center gap-1.5">
        <EmojiPicker label="Send a reaction" onSelect={call.reactions.send}>
          {(props) => (
            <button
              {...props}
              className="rounded-full border border-border px-2 py-1 text-muted-foreground hover:text-foreground"
              data-testid="huddle-react"
              type="button"
            >
              <SmilePlus aria-hidden className="h-3.5 w-3.5" />
            </button>
          )}
        </EmojiPicker>

        <button
          aria-pressed={voice.enabled && voice.supported}
          className={cn(
            "flex items-center gap-1 rounded-full border px-2 py-1 text-xs font-medium disabled:opacity-50",
            voice.enabled
              ? "border-emerald-600/50 bg-emerald-600/20 text-emerald-400"
              : "border-border text-muted-foreground",
          )}
          data-testid="huddle-voice-mode"
          disabled={!voice.supported}
          onClick={() => voice.setEnabled(!voice.enabled)}
          title={
            voice.enabled
              ? "Stop voice mode — speech stops posting to this huddle."
              : "Voice mode — what you say posts to this huddle as your messages."
          }
          type="button"
        >
          <AudioLines
            aria-hidden
            className={cn("h-3.5 w-3.5", voice.enabled && "animate-pulse")}
          />
          <span className="sr-only">
            {voice.enabled ? "Stop voice mode" : "Start voice mode"}
          </span>
        </button>

        <button
          aria-pressed={speaking}
          className={cn(
            "flex items-center gap-1 rounded-full border px-2 py-1 text-xs font-medium disabled:opacity-50",
            speaking
              ? "border-emerald-600/50 bg-emerald-600/20 text-emerald-400"
              : "border-border text-muted-foreground",
          )}
          data-testid="huddle-agent-speech"
          disabled={!speech.supported}
          onClick={() => speech.setEnabled(!speech.enabled)}
          title={
            speech.suppressedAgents.length > 0
              ? "Agent speech is on. Agents already broadcasting into the call are not re-spoken here."
              : "Read agent replies aloud in this browser only."
          }
          type="button"
        >
          {speaking ? (
            <Volume2 aria-hidden className="h-3.5 w-3.5" />
          ) : (
            <VolumeX aria-hidden className="h-3.5 w-3.5" />
          )}
          <span className="sr-only">
            {speaking ? "Stop reading agent replies" : "Read agent replies"}
          </span>
        </button>

        <button
          className="rounded-full border border-border px-2 py-1 text-muted-foreground hover:text-foreground"
          data-testid="huddle-add-agent"
          onClick={() => setAddAgentOpen(true)}
          title="Add an agent to this huddle"
          type="button"
        >
          <Bot aria-hidden className="h-3.5 w-3.5" />
          <span className="sr-only">Add an agent</span>
        </button>

        <HuddleSettingsPopover onChange={call.setPrefs} prefs={call.prefs} />
      </div>

      <div className="ml-auto flex items-center gap-2">
        <button
          aria-pressed={floating}
          className="rounded-full border border-border px-2 py-1 text-muted-foreground hover:text-foreground"
          data-testid="huddle-float-toggle"
          onClick={() => setFloating(!floating)}
          title={floating ? "Dock the huddle" : "Float the huddle"}
          type="button"
        >
          {floating ? (
            <Minimize2 aria-hidden className="h-3.5 w-3.5" />
          ) : (
            <Maximize2 aria-hidden className="h-3.5 w-3.5" />
          )}
          <span className="sr-only">
            {floating ? "Dock the huddle" : "Float the huddle"}
          </span>
        </button>
        <button
          className="rounded-full bg-red-500/90 px-3 py-1 text-xs font-medium text-white hover:bg-red-500"
          data-testid="huddle-leave"
          onClick={call.leave}
          type="button"
        >
          Leave
        </button>
      </div>

      {call.reactions.error && (
        <span className="text-2xs text-red-400" role="alert">
          {call.reactions.error}
        </span>
      )}

      <AddHuddleAgentDialog
        currentAgentPubkeys={call.agentPubkeys}
        onAdd={call.addAgent}
        onOpenChange={setAddAgentOpen}
        open={addAgentOpen}
      />
    </div>
  );
}
