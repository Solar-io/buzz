import { agentRecentlyActive } from "../lib/observerEvents";
import { useAgentFrames } from "../ObserverProvider";

/** Shared working indicator for channel member and direct-message pickers. */
export function AgentWorkingDot({ pubkey }: { pubkey: string }) {
  const frames = useAgentFrames(pubkey);
  const active = agentRecentlyActive(frames, Math.floor(Date.now() / 1000));
  return (
    <span
      title={active ? "Working" : "Idle"}
      className={
        active
          ? "inline-block h-2 w-2 rounded-full bg-leaf"
          : "inline-block h-2 w-2 rounded-full bg-muted-foreground/40"
      }
    />
  );
}
