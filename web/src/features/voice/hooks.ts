import { useCallback, useEffect, useMemo, useState } from "react";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import { speechServiceUrl } from "@/shared/lib/relay-url";
import {
  KIND_AGENT_VOICE,
  reduceAgentVoiceEvents,
  type AgentVoiceEventLike,
  type AgentVoiceSelection,
  type AgentVoiceSelectionRow,
} from "./lib/agentVoiceSelection.ts";
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

/**
 * The tts bridge's ElevenLabs voice library — the third engine family the
 * picker offers. Plain fetch of the bridge's `/voices/eleven` (the key never
 * leaves the server), built from the serving hostname exactly like the STT
 * bridge URL. No subscription: the library changes rarely and the bridge
 * caches upstream for ten minutes.
 */
export function useElevenVoices(): {
  voices: { id: string; label: string }[];
  ready: boolean;
} {
  const [voices, setVoices] = useState<{ id: string; label: string }[]>([]);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const controller = new AbortController();
    fetch(new URL("/voices/eleven", speechServiceUrl("tts")).href, {
      signal: controller.signal,
    })
      .then((res) =>
        res.ok ? res.json() : Promise.reject(new Error(`bridge ${res.status}`)),
      )
      .then((body: { voices?: { id: string; label: string }[] }) => {
        setVoices(Array.isArray(body.voices) ? body.voices : []);
      })
      .catch(() => {
        // Keyless or unreachable: the picker simply shows the other engines.
        setVoices([]);
      })
      .finally(() => setReady(true));
    return () => controller.abort();
  }, []);
  return { voices, ready };
}
