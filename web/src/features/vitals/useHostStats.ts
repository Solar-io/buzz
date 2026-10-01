import { useSyncExternalStore } from "react";

import { fetchHostStats } from "@/features/terminal/lib/hatchClient.ts";
import { hatchUrl } from "@/features/terminal/lib/hatchConfig.ts";
import {
  createHostStatsPoller,
  type HostStatsPoller,
  type HostStatsSnapshot,
  IDLE_SNAPSHOT,
} from "./hostStatsPoller.ts";

let poller: HostStatsPoller | null = null;

function shared(base: string): HostStatsPoller {
  if (!poller) {
    poller = createHostStatsPoller({
      fetch: () => fetchHostStats(base),
      isHidden: () => document.visibilityState === "hidden",
      onVisibilityChange: (listener) => {
        document.addEventListener("visibilitychange", listener);
        return () => document.removeEventListener("visibilitychange", listener);
      },
      setInterval: (fn, ms) => window.setInterval(fn, ms),
      clearInterval: (handle) => window.clearInterval(handle as number),
    });
  }
  return poller;
}

const noSubscribe = () => () => {};
const idle = () => IDLE_SNAPSHOT;

/**
 * crichton's host stats, or null when no hatch is configured (the rows then
 * do not exist at all). One poll is shared by every consumer.
 */
export function useHostStats(): HostStatsSnapshot | null {
  const base = hatchUrl();
  const source = base ? shared(base) : null;
  const snapshot = useSyncExternalStore(
    source ? source.subscribe : noSubscribe,
    source ? source.getSnapshot : idle,
    source ? source.getSnapshot : idle,
  );
  return source ? snapshot : null;
}

export function refreshHostStats(): void {
  poller?.refresh();
}
