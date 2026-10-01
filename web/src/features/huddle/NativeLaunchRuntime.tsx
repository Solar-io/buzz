import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { router } from "@/app/router";
import { useAuth } from "@/features/auth/ui/AuthProvider";
import { openDm } from "@/features/dms/hooks";
import { queryOnce } from "@/features/pulse/lib/relayQuery.ts";
import type { RelaySession } from "@/shared/api/relay-session";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { useOwnPubkey } from "@/shared/lib/useOwnPubkey";
import { BuzzLaunch, isNativeIOS } from "@/shared/platform/native";
import { type HuddleSession, useHuddleSession } from "./HuddleSessionProvider";
import { HUDDLE_LIFECYCLE_KINDS } from "./lib/huddleParticipants.ts";
import {
  browserStorage,
  callableAgentsFromEvents,
  createLaunchConsumer,
  type LaunchIntent,
  liveRoomWithAgent,
  parseLaunchUrl,
  readLastCallAgent,
  resolveLaunchAgent,
  waitUntil,
} from "./lib/launchIntent.ts";

/** Cold start: identity unlock + relay AUTH. Past this the user is told. */
const READY_TIMEOUT_MS = 45_000;
const QUERY_TIMEOUT_MS = 10_000;

interface LaunchContext {
  canSign: boolean;
  status: string;
  session: RelaySession;
  selfPubkey: string | null;
  huddle: HuddleSession;
}

/**
 * Carries out a `buzzweb://call…` launch (the "Buzz Voice" dock button).
 *
 * Mounted inside `HuddleSessionProvider` so it can start the ONE app-level
 * call. Reads the native pending intent on mount, on foreground and on the
 * plugin's `launch` event; `createLaunchConsumer` guarantees each tap is
 * handled once and acknowledged once, so a link never re-dials.
 */
export function NativeLaunchRuntime() {
  const { canSign } = useAuth();
  const { session, status } = useRelaySession();
  const huddle = useHuddleSession();
  const selfPubkey = useOwnPubkey();
  const context = useRef<LaunchContext>({
    canSign,
    status,
    session,
    selfPubkey,
    huddle,
  });
  context.current = { canSign, status, session, selfPubkey, huddle };

  useEffect(() => {
    if (!isNativeIOS()) return;
    let alive = true;
    const consume = createLaunchConsumer({
      source: BuzzLaunch,
      handle: (intent, acknowledge) =>
        carryOutLaunch(
          intent,
          acknowledge,
          () => context.current,
          () => alive,
        ),
    });
    const run = () => {
      void consume().catch((error: unknown) => {
        if (alive)
          toast.error("Buzz Voice could not start the call", {
            description:
              error instanceof Error ? error.message : "Try again from Buzz.",
          });
      });
    };
    const launch = BuzzLaunch.addListener("launch", run);
    const foreground = () => {
      if (!document.hidden) run();
    };
    document.addEventListener("visibilitychange", foreground);
    run();
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", foreground);
      void launch.then((handle) => handle.remove());
    };
  }, []);
  return null;
}

async function carryOutLaunch(
  intent: LaunchIntent,
  acknowledge: () => Promise<void>,
  read: () => LaunchContext,
  alive: () => boolean,
): Promise<void> {
  const request = parseLaunchUrl(intent.url);
  // Malformed, or a plain open: nothing to do beyond being foregrounded.
  if (request === null || request.action === "open") return;

  const ready = await waitUntil(() => {
    const now = read();
    return now.canSign && now.status === "open" && now.selfPubkey !== null;
  }, READY_TIMEOUT_MS);
  if (!alive()) return;
  if (!ready) {
    toast.error("Buzz Voice could not connect", {
      description: read().canSign
        ? "The relay did not connect in time. Open Buzz and try again."
        : "Sign in to Buzz (or unlock it), then try Buzz Voice again.",
    });
    return;
  }

  const { session, selfPubkey } = read();
  if (!selfPubkey) return;
  const [registry, catalogs] = await Promise.all([
    queryOnce(
      session,
      { kinds: [30177], authors: [selfPubkey], limit: 200 },
      QUERY_TIMEOUT_MS,
    ),
    queryOnce(
      session,
      { kinds: [30180], authors: [selfPubkey], limit: 100 },
      QUERY_TIMEOUT_MS,
    ),
  ]);
  const resolution = resolveLaunchAgent(
    request.agent,
    callableAgentsFromEvents(registry, catalogs),
    readLastCallAgent(browserStorage(), selfPubkey),
  );
  if (!alive()) return;
  if (!resolution.ok) {
    if (resolution.reason === "no-last") toast.info(resolution.message);
    else
      toast.error("Buzz Voice", {
        description: resolution.message,
      });
    return;
  }
  const agent = resolution.agent;

  // Already on a call with this agent: show it, never dial a second one.
  const { huddle } = read();
  if (
    huddle.active !== null &&
    huddle.directAgentCall &&
    huddle.call.agentPubkeys.some(
      (pubkey) => pubkey.toLowerCase() === agent.pubkey,
    )
  ) {
    await router.navigate({
      to: "/repos",
      search: { c: huddle.active.parentChannelId ?? undefined },
    });
    huddle.setFloating(false);
    return;
  }

  const dm = await openDm(session, [agent.pubkey]);
  if (!dm.ok || !dm.channelId) {
    toast.error(`Could not open your DM with ${agent.name}`, {
      description: dm.message || "The relay did not name the conversation.",
    });
    return;
  }
  await router.navigate({ to: "/repos", search: { c: dm.channelId } });
  const lifecycle = await queryOnce(
    session,
    { kinds: [...HUDDLE_LIFECYCLE_KINDS], "#h": [dm.channelId], limit: 200 },
    QUERY_TIMEOUT_MS,
  );
  // Cleared BEFORE dialing: a relaunch mid-call must not dial again.
  await acknowledge();
  if (!alive()) return;
  await read().huddle.startAgentCall({
    parentChannelId: dm.channelId,
    agentPubkey: agent.pubkey,
    agentName: agent.name,
    existingHuddleChannelId: liveRoomWithAgent(
      lifecycle,
      dm.channelId,
      agent.pubkey,
    ),
  });
}
