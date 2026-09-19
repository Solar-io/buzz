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

import { useOwnPubkey } from "@/shared/lib/useOwnPubkey";

import {
  useHuddleCall,
  type HuddleCall,
  type HuddleCallTarget,
} from "./useHuddleCall.ts";
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
  const [target, setTarget] = useState<HuddleCallTarget | null>(null);
  const [floating, setFloatingState] = useState(false);
  const [dockCount, setDockCount] = useState(0);
  /**
   * Set when a join was requested and the audio hook has not been told yet.
   * `join()` is a callback over the CURRENT channel id, so a join issued in
   * the same tick as the target change would dial the previous room (or
   * none). One render later it is the right one.
   */
  const pendingJoinRef = useRef<string | null>(null);

  const call = useHuddleCall({ target, selfPubkey });
  const { status, join } = call.huddle;

  useEffect(() => {
    const pending = pendingJoinRef.current;
    if (pending === null || pending !== call.channelId || status !== "idle") {
      return;
    }
    pendingJoinRef.current = null;
    void join();
  }, [call.channelId, status, join]);

  // The relay ended the room, the ladder ran out, or the user left: the
  // call is over, so the dock, the panel and the pill must all go with it.
  useEffect(() => {
    if (
      target !== null &&
      status === "idle" &&
      pendingJoinRef.current === null
    ) {
      setTarget(null);
      setFloatingState(false);
    }
  }, [target, status]);

  const requestJoin = useCallback(
    (next: HuddleCallTarget) => {
      if (target !== null && target.huddleChannelId !== next.huddleChannelId) {
        return {
          ok: false,
          message: "You're already in a huddle — leave that one first.",
        };
      }
      pendingJoinRef.current = next.huddleChannelId;
      setTarget(next);
      return { ok: true, message: "Joining…" };
    },
    [target],
  );

  const setDockMounted = useCallback((mounted: boolean) => {
    setDockCount((count) => Math.max(0, count + (mounted ? 1 : -1)));
  }, []);

  const value = useMemo<HuddleSession>(
    () => ({
      call,
      active: target,
      requestJoin,
      floating,
      setFloating: setFloatingState,
      setDockMounted,
    }),
    [call, target, requestJoin, floating, setDockMounted],
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
