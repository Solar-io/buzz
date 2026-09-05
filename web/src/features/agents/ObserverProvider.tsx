import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  useSyncExternalStore,
} from "react";
import * as nip44 from "nostr-tools/nip44";
import { getPublicKey } from "nostr-tools";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import {
  getAuthState,
  getUnlockedSecretKey,
  subscribeAuth,
} from "@/shared/lib/key-store";
import {
  capFrames,
  expandObserverFrame,
  parseObserverPayload,
  type ObserverFrame,
} from "./lib/observerEvents";
import {
  agentHistoryFilter,
  FRAMES_PER_AGENT,
  liveObserverFilter,
} from "./lib/observerFilters";

/**
 * Global observer store — the desktop's architecture, ported.
 *
 * ONE live subscription for every kind-24200 frame addressed to the local
 * user. Each frame is decrypted once and indexed under its AGENT identity:
 * the ["agent", <pubkey>] tag buzz-core puts on every frame, falling back to
 * the signer pubkey. Consumers select per agent (sidebar dots, the open DM's
 * thinking pane, working state), so several agents can be visibly working at
 * once and one pane can never show another agent's frames.
 *
 * ## Two REQs, not one
 *
 * The relay answers a kind-24200 REQ with ONE shared page across every agent,
 * so a chatty agent starves the quiet ones: measured on the dev relay, the
 * full 1000-event page covered four of the twenty-three agents with retained
 * history, 714 of the slots going to one of them.
 *
 * So the live subscription is a bounded lookback covering every agent — what
 * the sidebar dots and the working timers need, both of which only look back
 * 180 seconds. An agent's EARLIER turns come from a separate, author-scoped
 * history REQ opened by `useAgentObserverHistory` while that agent's panel is
 * on screen, so its past can never be displaced by a neighbour's volume.
 * `lib/observerFilters.ts` carries both filters and the measurement.
 *
 * The desktop needs no equivalent: it replays its own local Tauri archive,
 * while the relay is the web client's only memory.
 */

/**
 * Envelope ids remembered for de-duplication. History and the live window
 * overlap by construction, and a reconnect replays the live REQ, so the same
 * envelope arrives more than once. Ingesting it twice would double a
 * thought's text: `transcriptFromFrames` CONCATENATES agent_thought_chunk
 * content per message id, so a repeat is not idempotent.
 */
const SEEN_ENVELOPE_CAP = 4000;

export interface ObserverStore {
  /** agent pubkey → decrypted frames (arrival order). */
  byAgent: Map<string, ObserverFrame[]>;
  /** Frames that failed to decrypt with the local key. */
  lockedCount: number;
  connected: boolean;
  /** The viewer's own pubkey, or null before the key store resolves. */
  ownerPubkey: string | null;
  /** Decrypt one envelope and index it. Shared by the live and history REQs. */
  ingest: (event: SignedNostrEvent) => void;
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
  const seenEnvelopes = useRef<Set<string>>(new Set());
  /**
   * The auth store's own signal that the key situation changed.
   *
   * `enabled` is `canSign`, which is `unlocked || extensionAvailable` — so
   * with a Nostr extension installed it is true from the first render, BEFORE
   * `initKeyStore()` has restored the local key from IndexedDB. The effect
   * below then reads a null secret, returns early, and never re-runs, because
   * none of `session`/`status`/`enabled` change when the key finally arrives.
   * The result is a session with no observer subscription at all: the thinking
   * panel sits at "0 frames" forever, and it is intermittent, because a fast
   * restore wins the race and a slow one does not.
   *
   * Subscribing here gives the effect a dependency that DOES change on unlock.
   */
  const authState = useSyncExternalStore(
    subscribeAuth,
    getAuthState,
    getAuthState,
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: `authState` is a trigger, not a read — the body deliberately ignores its value and re-derives the owner when the key store resolves.
  const ownerPubkey = useMemo(() => {
    if (!enabled) {
      return null;
    }
    const secretKey = getUnlockedSecretKey();
    if (!secretKey) {
      return null;
    }
    try {
      return getPublicKey(secretKey);
    } catch {
      return null;
    }
  }, [enabled, authState]);

  /**
   * Decrypt and index one envelope. Reads the secret key at call time rather
   * than closing over it, so a key that arrives after a subscription opened
   * is still used — and so the live REQ and every per-agent history REQ share
   * exactly one code path, including de-duplication.
   */
  const ingest = useCallback((event: SignedNostrEvent) => {
    if (seenEnvelopes.current.has(event.id)) {
      return;
    }
    const secretKey = getUnlockedSecretKey();
    if (!secretKey) {
      return;
    }
    seenEnvelopes.current.add(event.id);
    if (seenEnvelopes.current.size > SEEN_ENVELOPE_CAP) {
      seenEnvelopes.current = new Set(
        Array.from(seenEnvelopes.current).slice(-SEEN_ENVELOPE_CAP / 2),
      );
    }
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
  }, []);

  useEffect(() => {
    if (status === "idle" || !ownerPubkey) {
      return;
    }
    return session.subscribe(
      liveObserverFilter(ownerPubkey, Math.floor(Date.now() / 1000)),
      { onEvent: ingest },
    );
  }, [session, status, ownerPubkey, ingest]);

  const value = useMemo<ObserverStore>(
    () => ({
      byAgent,
      lockedCount,
      connected: status === "open",
      ownerPubkey,
      ingest,
    }),
    [byAgent, lockedCount, status, ownerPubkey, ingest],
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

/**
 * Load one agent's retained observer history into the store.
 *
 * Call this from a surface that shows an agent's PAST — the DM thinking
 * panel — not from the sidebar rows, which only need the live window and
 * would otherwise fetch a page per row.
 *
 * `authors:[agentPubkey]` is an exact discriminator: the relay requires the
 * frame's signer to be the agent it is about (`agent_observer_route`), and
 * all 100,893 retained frames on the dev relay satisfy signer == agent tag.
 * The filter is pushed into SQL next to the `#p` join
 * (`crates/buzz-db/src/event.rs`), measured at ~11ms for a 500-row page.
 *
 * The REQ closes itself at EOSE: the live subscription already carries this
 * agent's new frames, so holding it open would only duplicate them.
 */
export function useAgentObserverHistory(agentPubkey: string | null): void {
  const store = useObserverStore();
  const { session, status } = useRelaySession();
  const ownerPubkey = store?.ownerPubkey ?? null;
  const ingest = store?.ingest;

  useEffect(() => {
    if (!agentPubkey || !ownerPubkey || !ingest || status === "idle") {
      return;
    }
    let unsubscribe: (() => void) | null = null;
    let closed = false;
    const close = () => {
      if (closed) {
        return;
      }
      closed = true;
      unsubscribe?.();
    };
    unsubscribe = session.subscribe(
      agentHistoryFilter(ownerPubkey, agentPubkey),
      { onEvent: ingest, onEose: close },
    );
    // EOSE may already have fired synchronously inside subscribe().
    if (closed) {
      unsubscribe();
    }
    return close;
  }, [session, status, agentPubkey, ownerPubkey, ingest]);
}
