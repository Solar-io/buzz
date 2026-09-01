import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import * as nip44 from "nostr-tools/nip44";
import { getPublicKey } from "nostr-tools";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { getUnlockedSecretKey } from "@/shared/lib/key-store";
import {
  capFrames,
  expandObserverFrame,
  parseObserverPayload,
  type ObserverFrame,
} from "./lib/observerEvents";

/**
 * Global observer store — the desktop's architecture, ported.
 *
 * ONE subscription for every kind-24200 frame addressed to the local user
 * (the relay's ephemeral fan-out delivers all of them anyway — authors
 * filters are not honored server-side). Each frame is decrypted once and
 * indexed under its AGENT identity: the ["agent", <pubkey>] tag buzz-core
 * puts on every frame, falling back to the signer pubkey. Consumers select
 * per agent (sidebar dots, the open DM's thinking pane, working state), so
 * several agents can be visibly working at once and one pane can never show
 * another agent's frames.
 */

const FRAMES_PER_AGENT = 200;

export interface ObserverStore {
  /** agent pubkey → decrypted frames (arrival order). */
  byAgent: Map<string, ObserverFrame[]>;
  /** Frames that failed to decrypt with the local key. */
  lockedCount: number;
  connected: boolean;
}

const ObserverContext = createContext<ObserverStore | null>(null);

function frameAgentPubkey(event: SignedNostrEvent): string {
  const tag = event.tags.find(
    (candidate) =>
      Array.isArray(candidate) && candidate[0] === "agent" && candidate[1],
  );
  return tag?.[1] ?? event.pubkey;
}

function decodeFrame(
  event: SignedNostrEvent,
  secretKey: Uint8Array,
): ObserverFrame[] | null {
  try {
    const conversationKey = nip44.v2.utils.getConversationKey(
      secretKey,
      event.pubkey,
    );
    const plaintext = nip44.v2.decrypt(event.content, conversationKey);
    const parsed = parseObserverPayload(plaintext);
    if (!parsed) {
      return null;
    }
    return expandObserverFrame({
      ...parsed,
      id: event.id,
      createdAt: event.created_at,
    });
  } catch {
    return null;
  }
}

export function ObserverProvider({
  enabled,
  children,
}: {
  enabled: boolean;
  children: ReactNode;
}) {
  const { session, status } = useRelaySession();
  const [byAgent, setByAgent] = useState<Map<string, ObserverFrame[]>>(
    () => new Map(),
  );
  const [lockedCount, setLockedCount] = useState(0);

  useEffect(() => {
    if (!enabled || status === "idle") {
      return;
    }
    const secretKey = enabled ? getUnlockedSecretKey() : null;
    if (!secretKey) {
      return;
    }
    let ownerPubkey: string;
    try {
      ownerPubkey = getPublicKey(secretKey);
    } catch {
      return;
    }
    return session.subscribe(
      { kinds: [24200], "#p": [ownerPubkey] },
      {
        onEvent: (event) => {
          const frame = decodeFrame(event, secretKey);
          if (!frame) {
            setLockedCount((n) => n + 1);
            return;
          }
          const agent = frameAgentPubkey(event);
          setByAgent((previous) => {
            const next = new Map(previous);
            const frames = [...(next.get(agent) ?? []), ...frame];
            next.set(agent, capFrames(frames, FRAMES_PER_AGENT));
            return next;
          });
        },
      },
    );
  }, [session, status, enabled]);

  const value = useMemo<ObserverStore>(
    () => ({
      byAgent,
      lockedCount,
      connected: status === "open",
    }),
    [byAgent, lockedCount, status],
  );
  return (
    <ObserverContext.Provider value={value}>
      {children}
    </ObserverContext.Provider>
  );
}

export function useObserverStore(): ObserverStore | null {
  return useContext(ObserverContext);
}

/** Per-agent frame selection for panes and indicators. */
export function useAgentFrames(agentPubkey: string | null): ObserverFrame[] {
  const store = useObserverStore();
  const frames = store?.byAgent.get(agentPubkey ?? "") ?? [];
  return frames;
}
