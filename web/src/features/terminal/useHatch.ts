import { useCallback, useEffect, useRef, useState } from "react";

import {
  fetchHerdr,
  fetchMe,
  type HatchMe,
  type HatchResult,
  type HerdrSnapshot,
} from "./lib/hatchClient.ts";
import { hatchOrigin } from "./lib/hatchConfig.ts";
import { createSignInListener, signInUrl } from "./lib/signIn.ts";

export type SessionState = { kind: "loading" } | HatchResult<HatchMe>;

/**
 * Who we are to crichton (`GET /api/me`), and the sign-in flow. Re-checks on
 * hatch's `hatch:signed-in` message (origin-checked), on window focus and on
 * becoming visible — the popup may have lost its opener on the way through
 * GitHub, so the message is only the fast path.
 */
export function useHatchSession(base: string) {
  const [state, setState] = useState<SessionState>({ kind: "loading" });
  const generation = useRef(0);
  const onSignedIn = useRef<(() => void) | null>(null);

  const refresh = useCallback(async (): Promise<SessionState> => {
    const mine = ++generation.current;
    const result = await fetchMe(base);
    if (mine === generation.current) {
      setState(result);
    }
    return result;
  }, [base]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const signedIn = createSignInListener(hatchOrigin(base), () => {
      void refresh().then((result) => {
        if (result.kind === "ok") onSignedIn.current?.();
      });
    });
    const recheck = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("message", signedIn);
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      window.removeEventListener("message", signedIn);
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, [base, refresh]);

  const signIn = useCallback(() => {
    // Top-level window: GitHub refuses frames, PKCE needs a top-level return.
    window.open(signInUrl(base), "hatch-sign-in", "popup,width=560,height=760");
  }, [base]);

  return {
    state,
    refresh,
    signIn,
    /** Called after a sign-in completes (the page reconnects the socket). */
    setOnSignedIn: (fn: (() => void) | null) => {
      onSignedIn.current = fn;
    },
  };
}

const HERDR_POLL_MS = 3_000;

/**
 * herdr's spaces / tabs / agents, polled every 3 s while the page is visible
 * (hatch caches the snapshot 2 s, so this is at most one `herdr api snapshot`
 * per poll). `null` until the first answer; a failed poll keeps the last good
 * snapshot but flags it.
 */
export function useHerdr(base: string, enabled: boolean) {
  const [snapshot, setSnapshot] = useState<HerdrSnapshot | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      timer = null;
      if (document.visibilityState === "visible") {
        const result = await fetchHerdr(base);
        if (cancelled) return;
        if (result.kind === "ok") {
          setSnapshot(result.data);
          setFailed(false);
        } else {
          setFailed(true);
        }
      }
      if (!cancelled) timer = setTimeout(poll, HERDR_POLL_MS);
    };
    void poll();
    const onVisible = () => {
      if (document.visibilityState === "visible" && timer !== null) {
        clearTimeout(timer);
        void poll();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [base, enabled]);

  return { snapshot, failed };
}
