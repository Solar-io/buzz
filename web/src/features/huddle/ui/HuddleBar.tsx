import { useEffect, useRef } from "react";
import { toast } from "sonner";

import { truncatePubkey } from "@/shared/lib/pubkey";

import {
  clearHuddleVoiceState,
  loadHuddleVoiceState,
  VOICE_RESTORE_FAILED,
  type VoiceStateStore,
} from "../lib/huddleVoicePersistence.ts";
import { huddleJoinGate } from "../lib/huddleJoinGate.ts";
import { useHuddleParentFallback } from "../useHuddleParentFallback";
import { useHuddleSession } from "../HuddleSessionProvider.tsx";

/** The store the armed voice state persists to (injected for tests). */
const voiceStateStore: VoiceStateStore | null =
  typeof window !== "undefined" && window.sessionStorage
    ? window.sessionStorage
    : null;

/**
 * The JOIN surface for a huddle channel — and now only that.
 *
 * The call itself moved up to `HuddleSessionProvider` (S1), so that it
 * survives route changes and can be docked or floated. What is left here is
 * everything that is genuinely about THIS channel's page: the three-state
 * join gate, the cold-load parent resolution it depends on, the pre-join
 * microphone picker, and the honest failure leg for armed voice state that
 * can never be restored because the room is dead.
 *
 * JOIN GATING is the join gate's three states, not one blunt rule. The
 * relay denies audio auth on an ephemeral channel with no parent link
 * ("ephemeral channel requires parent linkage",
 * crates/buzz-relay/src/audio/handler.rs), so a genuinely unlinked room is
 * disabled WITH that reason; a room whose linkage query is still in flight
 * shows no failure reason; and an ENDED huddle renders no Join at all — an
 * enabled Join that dead-ends against the relay's "channel is archived"
 * refusal was the V1b dead-join defect (VOICE_E2E_2026-09-17).
 *
 * Reload survival is unchanged: the parent link is re-resolved from the
 * wire on a cold load — ambient registry first, then a targeted query
 * against the huddle's own kind-48106 guidelines — so a reload can rejoin.
 * The armed-state RESTORE now happens in the provider, on the call's first
 * connected edge; what stays here is its failure leg, because only this
 * component knows the huddle has ended.
 */
export function HuddleBar({
  channelId,
  parentChannelId,
  huddleEnded = false,
  huddleLinksResolved = false,
}: {
  channelId: string;
  /** Linked parent channel — required by the audio room for ephemeral joins. */
  parentChannelId?: string | null;
  /**
   * The relay has retired this huddle: a kind-48103 was seen (live or in
   * the replay) or the backing channel's kind-39000 says archived.
   */
  huddleEnded?: boolean;
  /**
   * The ambient registry feed has replayed at least once. The unlinked
   * verdict waits for this AND the targeted query, so a slow replay cannot
   * flash a false "no parent link" before its 48100 lands.
   */
  huddleLinksResolved?: boolean;
}) {
  const { call, active, requestJoin } = useHuddleSession();
  // The viewer's key comes from the session rather than a prop: the call
  // already has it, and two sources for one identity is one too many.
  const selfPubkey = call.selfPubkey;
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

  const isThisCall = active?.huddleChannelId === channelId;
  const busyElsewhere = active !== null && !isThisCall;
  const connectingHere = isThisCall && call.huddle.status === "connecting";
  const { huddle } = call;
  // Before any call exists the audio hook is idle but still enumerating, so
  // the pre-join picker is live — which is the only moment a microphone can
  // be chosen without interrupting anything.
  const showDevicePicker = !isThisCall && huddle.devices.length > 1;

  /**
   * The honest failure leg of the reload contract: if this huddle is dead
   * there is no rejoin that could bring the armed state back, so say so
   * once — and stop offering to restore it. Pretending otherwise (or
   * dropping the state with no signal) is the silent failure the reload
   * work exists to kill.
   */
  const failedRestoreSurfacedRef = useRef(false);
  useEffect(() => {
    if (!huddleEnded || isThisCall || failedRestoreSurfacedRef.current) {
      return;
    }
    if (voiceStateStore === null) {
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
  }, [huddleEnded, isThisCall, channelId]);

  if (isThisCall && call.connected) {
    // The call is live; the dock below the composer is its surface.
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-border bg-card/40 px-4 py-2">
      {gate.state === "ended" ? (
        <span
          className="rounded-full border border-red-500/40 bg-red-500/10 px-3 py-1 text-xs font-medium text-red-400"
          data-testid="huddle-ended"
          role="status"
        >
          {gate.reason}
        </span>
      ) : (
        <button
          className="rounded-full border border-emerald-600/50 bg-emerald-600/20 px-3 py-1 text-xs font-medium text-emerald-400 disabled:opacity-50"
          data-testid="huddle-join-audio"
          disabled={
            connectingHere ||
            busyElsewhere ||
            !huddle.supportsVoice ||
            !gate.joinable
          }
          onClick={() => {
            const result = requestJoin({
              huddleChannelId: channelId,
              parentChannelId: resolvedParentId,
            });
            if (!result.ok) {
              toast.error(result.message);
            }
          }}
          title={
            busyElsewhere
              ? "You're already in a huddle — leave that one first."
              : (gate.reason ?? gate.hint ?? undefined)
          }
          type="button"
        >
          {connectingHere ? "Joining…" : "🎧 Join huddle"}
        </button>
      )}

      {showDevicePicker && (
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          <span className="sr-only">Microphone</span>
          <select
            className="max-w-48 truncate rounded border border-border bg-transparent px-1 py-0.5 text-xs"
            data-testid="huddle-device"
            onChange={(event) => void huddle.selectDevice(event.target.value)}
            value={huddle.deviceId}
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
      {isThisCall && huddle.error && (
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
    </div>
  );
}
