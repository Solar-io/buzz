import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import { useOwnPubkey } from "@/shared/lib/useOwnPubkey";
import { listLibrary, voiceLibraryUrl } from "./lib/voiceLibraryApi.ts";
import type { LibraryEngine, LibraryVoice } from "./lib/voiceLibraryModel.ts";
import {
  subscribeVoiceLibrary,
  voiceLibraryVersion,
} from "./lib/voiceLibraryRevision.ts";
import { speechServiceUrl } from "@/shared/lib/relay-url";
import {
  KIND_AGENT_VOICE,
  reduceAgentVoiceEvents,
  type AgentVoiceEventLike,
  type AgentVoiceSelection,
  type AgentVoiceSelectionRow,
} from "./lib/agentVoiceSelection.ts";
import {
  KIND_AGENT_VOICE_ASSIGNMENT,
  reduceAgentVoiceAssignmentEvents,
  type AgentVoiceAssignmentRow,
} from "./lib/agentVoiceAssignment.ts";
import {
  parseChatterboxRoster,
  type ChatterboxVoice,
} from "./lib/chatterboxRoster.ts";
import {
  KIND_VOICE_CATALOG,
  reduceVoiceCatalogEvents,
  type CatalogEventLike,
  type VoiceCatalogRow,
} from "./lib/voiceCatalog.ts";

/**
 * Live community voice catalog (kind 30181).
 *
 * One REQ covers the initial read and live fan-out — the relay answers with
 * the stored replaceable events, then keeps the subscription open (the
 * user-status pattern). The filter names `kinds` explicitly, which the
 * relay's p-gate requires of every query. There are no module-level caches:
 * one community per origin, so nothing survives a remount that should not.
 *
 * `ready` flips true on the subscription's EOSE, i.e. the initial historical
 * read is complete — a picker can use it to distinguish "empty catalog" from
 * "still loading".
 */
export function useVoiceCatalog(): {
  rows: VoiceCatalogRow[];
  ready: boolean;
} {
  const { session } = useRelaySession();
  const [events, setEvents] = useState<CatalogEventLike[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setEvents([]);
    setReady(false);
    return session.subscribe(
      { kinds: [KIND_VOICE_CATALOG], limit: 500 },
      {
        onEvent: (event: SignedNostrEvent) => {
          setEvents((previous) => [...previous, event]);
        },
        onEose: () => setReady(true),
      },
    );
  }, [session]);

  const rows = useMemo(
    () => Array.from(reduceVoiceCatalogEvents(events).values()),
    [events],
  );
  return { rows, ready };
}

/**
 * Live community agent-voice selections (kind 30182).
 *
 * Same subscription shape as {@link useVoiceCatalog}: one REQ names `kinds`
 * explicitly (the relay's p-gate requires it), no module-level caches, and
 * `ready` flips on EOSE. The fold is LWW per agent pubkey — the author IS
 * the agent identity, and NIP-33 keeps exactly one head at the fixed
 * `agent-voice` coordinate server-side.
 *
 * `agentVoiceSelectionFor(pubkey)` is the thin adapter the speak-time seam
 * consumes: it is the future `selected?` input of `speechVoiceProfile`
 * (CK's seat wires the one-line call site; this side deliberately does not
 * touch `useHuddleAgentSpeech`). When that seam lands, the profile it builds
 * carries `source: "selected" | "selected-rejected" | "derived"` — the
 * module rejects non-English selections and marks the source rather than
 * silently falling back — so the wiring assertion can check WHICH path
 * spoke, not just that a voice came out.
 */
export function useAgentVoiceSelections(): {
  byPubkey: Map<string, AgentVoiceSelectionRow>;
  ready: boolean;
  agentVoiceSelectionFor: (
    agentPubkey: string,
  ) => AgentVoiceSelection | undefined;
} {
  const { session } = useRelaySession();
  const [events, setEvents] = useState<AgentVoiceEventLike[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setEvents([]);
    setReady(false);
    return session.subscribe(
      { kinds: [KIND_AGENT_VOICE], limit: 500 },
      {
        onEvent: (event: SignedNostrEvent) => {
          setEvents((previous) => [...previous, event]);
        },
        onEose: () => setReady(true),
      },
    );
  }, [session]);

  const byPubkey = useMemo(() => reduceAgentVoiceEvents(events), [events]);
  const agentVoiceSelectionFor = useCallback(
    (agentPubkey: string) => byPubkey.get(agentPubkey)?.selection,
    [byPubkey],
  );
  return { byPubkey, ready, agentVoiceSelectionFor };
}

/** Curated bridge rows; every mounted consumer refreshes after library edits. */
export function useBridgeVoices(engine: LibraryEngine): {
  voices: LibraryVoice[];
  ready: boolean;
  error: string | null;
} {
  const version = useSyncExternalStore(
    subscribeVoiceLibrary,
    voiceLibraryVersion,
    voiceLibraryVersion,
  );
  const [state, setState] = useState<{
    voices: LibraryVoice[];
    ready: boolean;
    error: string | null;
  }>({ voices: [], ready: false, error: null });
  useEffect(() => {
    const controller = new AbortController();
    setState({ voices: [], ready: false, error: null });
    void listLibrary(engine, controller.signal).then(
      (voices) => {
        if (!controller.signal.aborted)
          setState({ voices, ready: true, error: null });
      },
      (cause: unknown) => {
        if (!controller.signal.aborted)
          setState({
            voices: [],
            ready: true,
            error:
              cause instanceof Error ? cause.message : "Could not load voices.",
          });
      },
    );
    return () => controller.abort();
  }, [engine, version]);
  return state;
}

/** Fail closed until the bridge's admin allowlist and current identity resolve. */
export function useVoiceLibraryAdmin(): { isAdmin: boolean; ready: boolean } {
  const pubkey = useOwnPubkey();
  const [admins, setAdmins] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(voiceLibraryUrl("/healthz"), { signal: controller.signal })
      .then((response) =>
        response.ok
          ? response.json()
          : Promise.reject(new Error("Bridge unavailable")),
      )
      .then((body: { libraryAdmins?: unknown }) => {
        if (!controller.signal.aborted)
          setAdmins(
            Array.isArray(body.libraryAdmins)
              ? body.libraryAdmins.filter(
                  (item): item is string => typeof item === "string",
                )
              : [],
          );
      })
      .catch(() => {
        if (!controller.signal.aborted) setAdmins([]);
      })
      .finally(() => {
        if (!controller.signal.aborted) setReady(true);
      });
    return () => controller.abort();
  }, []);
  return {
    isAdmin:
      pubkey !== null &&
      admins.some((admin) => admin.toLowerCase() === pubkey.toLowerCase()),
    ready,
  };
}

/**
 * Live owner voice assignments (kind 30183), folded per AGENT pubkey.
 *
 * Same subscription shape as {@link useAgentVoiceSelections}. Rows are
 * relay-verified at write time (`is_agent_owner`), so the fold does not
 * re-check ownership. `ingest` lets a surface that just published a clear
 * (kind-5 coordinate delete) apply it locally at once — a live REQ on
 * kind 30183 never delivers the deletion itself.
 */
export function useAgentVoiceAssignments(): {
  byAgent: Map<string, AgentVoiceAssignmentRow>;
  ready: boolean;
  assignmentFor: (agentPubkey: string) => AgentVoiceSelection | undefined;
  ingest: (event: AgentVoiceEventLike & { kind?: number }) => void;
} {
  const { session } = useRelaySession();
  const [events, setEvents] = useState<
    (AgentVoiceEventLike & { kind?: number })[]
  >([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setEvents([]);
    setReady(false);
    return session.subscribe(
      { kinds: [KIND_AGENT_VOICE_ASSIGNMENT], limit: 500 },
      {
        onEvent: (event: SignedNostrEvent) => {
          setEvents((previous) => [...previous, event]);
        },
        onEose: () => setReady(true),
      },
    );
  }, [session]);

  const byAgent = useMemo(
    () => reduceAgentVoiceAssignmentEvents(events),
    [events],
  );
  const assignmentFor = useCallback(
    (agentPubkey: string) => byAgent.get(agentPubkey.toLowerCase())?.selection,
    [byAgent],
  );
  const ingest = useCallback(
    (event: AgentVoiceEventLike & { kind?: number }) =>
      setEvents((previous) => [...previous, event]),
    [],
  );
  return { byAgent, ready, assignmentFor, ingest };
}

/**
 * The tts bridge's Chatterbox roster (`GET /voices/chatterbox`) — the voices
 * the picker offers and the labels every surface shows. Plain fetch like
 * {@link useBridgeVoices}; the bridge caches the service's roster for 60 s
 * and serves the last good copy (`stale: true`) when the service is down.
 */
export function useChatterboxVoices(): {
  voices: ChatterboxVoice[];
  ready: boolean;
} {
  const [voices, setVoices] = useState<ChatterboxVoice[]>([]);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const controller = new AbortController();
    fetch(new URL("/voices/chatterbox", speechServiceUrl("tts")).href, {
      signal: controller.signal,
    })
      .then((res) =>
        res.ok ? res.json() : Promise.reject(new Error(`bridge ${res.status}`)),
      )
      .then((body: unknown) => setVoices(parseChatterboxRoster(body)))
      .catch(() => {
        // Unreachable bridge: the picker shows its empty state.
        setVoices([]);
      })
      .finally(() => setReady(true));
    return () => controller.abort();
  }, []);
  return { voices, ready };
}
