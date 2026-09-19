import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";

import { useOwnPubkey } from "@/shared/lib/useOwnPubkey";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";

import {
  useHuddleCall,
  type HuddleCall,
  type HuddleCallTarget,
} from "./useHuddleCall.ts";
import { isCallOver, shouldDispatchJoin } from "./lib/huddleCallLifecycle.ts";
import {
  runAgentCallFlow,
  type AgentCallObservation,
  type AgentCallFlowOptions,
  type AgentCallPhase,
  type AgentCallResult,
} from "./lib/agentCallFlow.ts";
import { startHuddle } from "./lib/huddleLifecycle.ts";
import { HuddleFloatingPanel } from "./ui/HuddleFloatingPanel.tsx";
import { HuddlePill } from "./ui/HuddlePill.tsx";

/**
 * The app-level owner of the ONE active huddle call.
 *
 * Mounted above the router, so a call outlives every route change: that is
 * the whole premise of the dock (S2) and the floating panel (S3). Leaving
 * is explicit — the Leave button — or the relay ending the room.
 *
 * What this component owns beyond the call itself is presentation state
 * with app-wide scope: whether the panel is floating, and whether a dock is
 * currently mounted somewhere. The second one exists so the call is never
 * invisible: when no dock is on screen and nothing is floating, a pill
 * appears with the way back.
 */

export interface HuddleSession {
  /** The active call, or null. */
  call: HuddleCall;
  active: HuddleCallTarget | null;
  /** Join a huddle. Refused (with a reason) while another call is live. */
  requestJoin: (target: HuddleCallTarget) => { ok: boolean; message: string };
  /** Start the one-click call from a 1:1 agent DM. */
  startAgentCall: (options: AgentCallFlowOptions) => Promise<AgentCallResult>;
  /** Current phase of the one-click DM call flow. */
  agentCallPhase: AgentCallPhase;
  /** Last one-click call failure, kept visible for the current DM. */
  agentCallError: string | null;
  /** DM channel id that owns the current one-click call state. */
  agentCallParentChannelId: string | null;
  /** True while the active call is bound to one DM agent. */
  directAgentCall: boolean;
  floating: boolean;
  setFloating: (floating: boolean) => void;
  /** A dock mounts/unmounts itself here so the pill knows to appear. */
  setDockMounted: (mounted: boolean) => void;
}

const HuddleSessionContext = createContext<HuddleSession | null>(null);

export function useHuddleSession(): HuddleSession {
  const value = useContext(HuddleSessionContext);
  if (value === null) {
    throw new Error(
      "useHuddleSession must be used inside HuddleSessionProvider",
    );
  }
  return value;
}

export function HuddleSessionProvider({ children }: { children: ReactNode }) {
  const selfPubkey = useOwnPubkey();
  const { session } = useRelaySession();
  const [target, setTarget] = useState<HuddleCallTarget | null>(null);
  const [joinRequestVersion, setJoinRequestVersion] = useState(0);
  const [floating, setFloatingState] = useState(false);
  const [dockCount, setDockCount] = useState(0);
  const [agentCallPhase, setAgentCallPhaseState] =
    useState<AgentCallPhase>("idle");
  const [agentCallError, setAgentCallError] = useState<string | null>(null);
  const [agentCallParentChannelId, setAgentCallParentChannelId] = useState<
    string | null
  >(null);
  const [directAgentPubkey, setDirectAgentPubkey] = useState<string | null>(
    null,
  );
  /**
   * Set when a join was requested and the audio hook has not been told yet.
   * `join()` is a callback over the CURRENT channel id, so a join issued in
   * the same tick as the target change would dial the previous room (or
   * none). One render later it is the right one.
   */
  const pendingJoinRef = useRef<string | null>(null);
  const targetRef = useRef<HuddleCallTarget | null>(null);
  targetRef.current = target;
  const callIntentRef = useRef<{
    token: number;
    parentChannelId: string;
    agentPubkey: string;
  } | null>(null);
  const nextIntentTokenRef = useRef(0);
  const directAgentPubkeyRef = useRef<string | null>(null);

  const call = useHuddleCall({ target, selfPubkey });
  const callRef = useRef(call);
  callRef.current = call;
  const { status, join } = call.huddle;

  const setAgentCallPhase = useCallback((phase: AgentCallPhase) => {
    setAgentCallPhaseState(phase);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: joinRequestVersion intentionally retries the same room.
  useEffect(() => {
    if (
      !shouldDispatchJoin({
        pendingChannelId: pendingJoinRef.current,
        hookChannelId: call.channelId,
        status,
      })
    ) {
      return;
    }
    pendingJoinRef.current = null;
    void join();
  }, [call.channelId, status, join, joinRequestVersion]);

  // The relay ended the room, the ladder ran out, or the user left: the
  // call is over, so the dock, the panel and the pill must all go with it.
  // Decided on the TRANSITION into idle, never on idle alone — the
  // same-commit idle read right after the join dispatch above is the race
  // that dialed /huddle/null/audio (lib/huddleCallLifecycle.ts).
  const previousStatusRef = useRef(status);
  useEffect(() => {
    const previousStatus = previousStatusRef.current;
    previousStatusRef.current = status;
    if (isCallOver({ hasTarget: target !== null, previousStatus, status })) {
      setTarget(null);
      setFloatingState(false);
      directAgentPubkeyRef.current = null;
      setDirectAgentPubkey(null);
      callIntentRef.current = null;
      setAgentCallError(null);
      setAgentCallParentChannelId(null);
      setAgentCallPhase("idle");
    }
  }, [target, status, setAgentCallPhase]);

  const requestJoin = useCallback((next: HuddleCallTarget) => {
    const active = targetRef.current;
    if (active !== null && active.huddleChannelId !== next.huddleChannelId) {
      return {
        ok: false,
        message: "You're already in a huddle — leave that one first.",
      };
    }
    pendingJoinRef.current = next.huddleChannelId;
    setJoinRequestVersion((version) => version + 1);
    setTarget(next);
    return { ok: true, message: "Joining…" };
  }, []);

  const waitForAgentCallObservation = useCallback(
    async (
      predicate: (observation: AgentCallObservation) => boolean,
    ): Promise<boolean> => {
      const deadline = Date.now() + 30_000;
      const startedAt = Date.now();
      while (Date.now() < deadline) {
        const active = callRef.current;
        if (
          predicate({
            huddleChannelId: active.channelId,
            parentChannelId: active.parentChannelId,
            connected: active.connected,
            status: active.huddle.status,
            error: active.huddle.error,
            agentPubkeys: active.agentPubkeys,
          })
        ) {
          return true;
        }
        // A retry deliberately reuses a target whose previous join ended in
        // error. Let the provider effect dispatch the pending retry before
        // treating that stale status as a fresh failure.
        if (active.huddle.status === "error" && Date.now() - startedAt > 500) {
          return false;
        }
        if (targetRef.current === null && Date.now() + 250 < deadline) {
          // A leave can clear the target while this wait is asleep. Give the
          // target state one render to settle after requestJoin, then stop
          // rather than holding a stale intent for the whole timeout.
          await new Promise<void>((resolve) => window.setTimeout(resolve, 250));
          if (targetRef.current === null) {
            return false;
          }
        }
        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, 50);
        });
      }
      const active = callRef.current;
      return predicate({
        huddleChannelId: active.channelId,
        parentChannelId: active.parentChannelId,
        connected: active.connected,
        status: active.huddle.status,
        error: active.huddle.error,
        agentPubkeys: active.agentPubkeys,
      });
    },
    [],
  );

  const startAgentCall = useCallback(
    async (options: AgentCallFlowOptions): Promise<AgentCallResult> => {
      const requestedAgent = options.agentPubkey.toLowerCase();
      const active = targetRef.current;
      const currentIntent = callIntentRef.current;
      let flowOptions = options;
      if (active !== null) {
        const sameParent = active.parentChannelId === options.parentChannelId;
        const sameAgent =
          directAgentPubkeyRef.current?.toLowerCase() === requestedAgent;
        if (sameParent && sameAgent) {
          if (callRef.current.connected) {
            setFloatingState(false);
            return { ok: true, message: "This call is already open." };
          }
          // A retry is still allowed while the previous target is unwinding;
          // after the leave settles the next click provisions a clean room.
          flowOptions = {
            ...options,
            existingHuddleChannelId: active.huddleChannelId,
          };
        } else if (sameParent && directAgentPubkeyRef.current === null) {
          return {
            ok: false,
            message:
              "You're already in a huddle — leave it before starting this call.",
          };
        } else {
          return {
            ok: false,
            message: "You're already in another call — leave it first.",
          };
        }
      }
      if (currentIntent !== null) {
        const sameIntent =
          currentIntent.parentChannelId === options.parentChannelId &&
          currentIntent.agentPubkey === requestedAgent;
        return sameIntent
          ? { ok: false, message: "Your call is already starting…" }
          : {
              ok: false,
              message: "Another call is already starting — try again shortly.",
            };
      }
      if (
        !callRef.current.huddle.supportsVoice ||
        !callRef.current.voice.supported
      ) {
        const message = !callRef.current.huddle.supportsVoice
          ? "This browser cannot capture voice. Use a current Chrome, Edge, or Safari browser."
          : "Voice mode is unavailable in this browser.";
        setAgentCallError(message);
        toast.error("Voice calls are unavailable", { description: message });
        return { ok: false, message };
      }

      const token = ++nextIntentTokenRef.current;
      callIntentRef.current = {
        token,
        parentChannelId: options.parentChannelId,
        agentPubkey: requestedAgent,
      };
      directAgentPubkeyRef.current = requestedAgent;
      setDirectAgentPubkey(requestedAgent);
      setAgentCallError(null);
      setAgentCallParentChannelId(options.parentChannelId);

      let result: AgentCallResult;
      try {
        result = await runAgentCallFlow(flowOptions, {
          observe: () => {
            const currentCall = callRef.current;
            return {
              huddleChannelId: currentCall.channelId,
              parentChannelId: currentCall.parentChannelId,
              connected: currentCall.connected,
              status: currentCall.huddle.status,
              error: currentCall.huddle.error,
              agentPubkeys: currentCall.agentPubkeys,
            };
          },
          setPhase: setAgentCallPhase,
          provision: () =>
            startHuddle(session, {
              parentChannelId: flowOptions.parentChannelId,
              name: `${flowOptions.agentName} call`,
            }),
          requestJoin,
          addAgent: (input) =>
            callRef.current.addAgent({ ...input, alreadyParentMember: true }),
          armVoice: () => {
            const currentCall = callRef.current;
            if (
              currentCall.agentPubkeys.some(
                (pubkey) => pubkey.toLowerCase() === requestedAgent,
              )
            ) {
              currentCall.voice.setEnabled(true);
            }
          },
          waitFor: waitForAgentCallObservation,
          abortPartialCall: () => {
            pendingJoinRef.current = null;
            targetRef.current = null;
            callRef.current.leave();
            directAgentPubkeyRef.current = null;
            setDirectAgentPubkey(null);
            // Remove the target immediately so a failed join/add cannot be
            // mistaken for a live call while React is committing the leave.
            setTarget(null);
          },
          isCurrent: () => callIntentRef.current?.token === token,
        });
      } catch (error) {
        result = {
          ok: false,
          message:
            error instanceof Error
              ? error.message
              : "The voice call could not be started.",
        };
        if (callIntentRef.current?.token === token) {
          setAgentCallPhase("idle");
        }
      }

      if (callIntentRef.current?.token === token) {
        callIntentRef.current = null;
        if (result.ok) {
          setAgentCallError(null);
          toast.success(result.message);
        } else {
          directAgentPubkeyRef.current = null;
          setDirectAgentPubkey(null);
          setAgentCallError(result.message);
          toast.error("Could not start the voice call", {
            description: result.message,
          });
        }
      }
      return result;
    },
    [requestJoin, session, setAgentCallPhase, waitForAgentCallObservation],
  );

  const setDockMounted = useCallback((mounted: boolean) => {
    setDockCount((count) => Math.max(0, count + (mounted ? 1 : -1)));
  }, []);

  const value = useMemo<HuddleSession>(
    () => ({
      call,
      active: target,
      requestJoin,
      startAgentCall,
      agentCallPhase,
      agentCallError,
      agentCallParentChannelId,
      directAgentCall: directAgentPubkey !== null,
      floating,
      setFloating: setFloatingState,
      setDockMounted,
    }),
    [
      call,
      target,
      requestJoin,
      startAgentCall,
      agentCallPhase,
      agentCallError,
      agentCallParentChannelId,
      directAgentPubkey,
      floating,
      setDockMounted,
    ],
  );

  return (
    <HuddleSessionContext.Provider value={value}>
      {children}
      {/* The panel floats over EVERY route — that is the point of floating. */}
      {call.connected && floating && <HuddleFloatingPanel />}
      {/* ...and when neither a dock nor the panel is on screen, the pill is
          the call's only trace, so it must never be omitted. */}
      {call.connected && !floating && dockCount === 0 && <HuddlePill />}
    </HuddleSessionContext.Provider>
  );
}
