/**
 * `buzzweb://` launch links — the "Buzz Voice" dock button (Sam, 2026-10-01).
 *
 *   buzzweb://                       open the app
 *   buzzweb://open                   open the app
 *   buzzweb://call                   call the last agent called
 *   buzzweb://call?agent=<selector>  call that agent (name, npub or hex)
 *
 * Native (`BuzzLaunchPlugin.swift`) checks the same shape and persists the
 * newest call intent until the web acknowledges it. This module is the web's
 * authority: it re-parses the URL, resolves the agent against the owner's own
 * callable agents, and owns the consume-once rule so a link never re-dials.
 * Everything here is pure; `NativeLaunchRuntime.tsx` wires it to the app.
 */

import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import {
  agentFromEvent,
  mergeAgentEntry,
  type AgentRegistryEntry,
} from "../../agents/lib/agentRegistry.ts";
import { selectAvailableCandidates } from "../../agents/lib/availableAgents.ts";
import {
  desktopCatalogFromEvent,
  mergeDesktopCatalog,
  type DesktopCatalog,
} from "../../agents/lib/desktopCatalog.ts";
import { parsePubkeyInput } from "../../dms/lib/dmInput.ts";
import {
  applyHuddleLifecycle,
  huddleLifecycleFromEvent,
  liveHuddlesFor,
  type HuddleRoomMap,
} from "./huddleParticipants.ts";

export const LAUNCH_SCHEME = "buzzweb:";
export const MAX_AGENT_SELECTOR_LENGTH = 128;
/** A tap older than this is dropped, never dialed late. */
export const LAUNCH_INTENT_MAX_AGE_MS = 5 * 60_000;
export const LAST_CALL_AGENT_KEY = "buzz.voice.lastAgent.v1";
export const NO_LAST_AGENT_MESSAGE =
  "Start a voice call with an agent once — Buzz Voice will call them next time.";

export type LaunchRequest =
  | { action: "open" }
  | { action: "call"; agent: string | null };

export interface CallableAgent {
  pubkey: string;
  name: string;
}

export interface LaunchIntent {
  id: string;
  url: string;
  createdAt: number;
}

// Same rule as `BuzzLaunchPlugin.action(for:)`: Swift `.whitespaces` is
// Unicode Zs plus tab, `.controlCharacters` is Cc plus Cf, and the length is
// Unicode scalars. Spelled out because `String.prototype.trim` strips a
// different set (AGENTS.md: "the built-ins are the drift").
const EDGE_SPACE = /^[\p{Zs}\t]+|[\p{Zs}\t]+$/gu;
const CONTROL = /[\p{Cc}\p{Cf}]/u;

/** The trimmed agent selector, or null when it is empty, long or has controls. */
export function cleanAgentSelector(raw: string): string | null {
  const value = raw.replace(EDGE_SPACE, "");
  if (
    value.length === 0 ||
    [...value].length > MAX_AGENT_SELECTOR_LENGTH ||
    CONTROL.test(value)
  ) {
    return null;
  }
  return value;
}

/** Parse a launch URL; null for anything that is not exactly one of ours. */
export function parseLaunchUrl(raw: string): LaunchRequest | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (
    url.protocol.toLowerCase() !== LAUNCH_SCHEME ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.hash !== "" ||
    !(url.pathname === "" || url.pathname === "/")
  ) {
    return null;
  }
  const params = [...url.searchParams];
  switch (url.hostname.toLowerCase()) {
    case "":
    case "open":
      return params.length === 0 ? { action: "open" } : null;
    case "call": {
      if (params.length === 0) {
        return { action: "call", agent: null };
      }
      if (params.length !== 1 || params[0][0] !== "agent") {
        return null;
      }
      const agent = cleanAgentSelector(params[0][1]);
      return agent === null ? null : { action: "call", agent };
    }
    default:
      return null;
  }
}

export type AgentResolution =
  | { ok: true; agent: CallableAgent }
  | {
      ok: false;
      reason: "no-last" | "unavailable" | "unknown" | "ambiguous" | "invalid";
      message: string;
    };

/**
 * Which agent a call link means. Only the owner's own callable agents can be
 * dialed; a name must match exactly one of them (case-insensitively).
 */
export function resolveLaunchAgent(
  selector: string | null,
  agents: readonly CallableAgent[],
  last: CallableAgent | null,
): AgentResolution {
  const byPubkey = (pubkey: string) =>
    agents.find((agent) => agent.pubkey.toLowerCase() === pubkey);
  if (selector === null) {
    if (last === null) {
      return { ok: false, reason: "no-last", message: NO_LAST_AGENT_MESSAGE };
    }
    const current = byPubkey(last.pubkey.toLowerCase());
    return current
      ? { ok: true, agent: current }
      : {
          ok: false,
          reason: "unavailable",
          message: `${last.name} is no longer one of your agents. Start a call from their DM to pick someone else.`,
        };
  }
  const parsed = parsePubkeyInput(selector);
  if (parsed.ok) {
    const match = byPubkey(parsed.pubkey);
    return match
      ? { ok: true, agent: match }
      : {
          ok: false,
          reason: "unknown",
          message: "That link names a key that is not one of your agents.",
        };
  }
  if (parsed.reason === "wrong-type") {
    return { ok: false, reason: "invalid", message: parsed.error };
  }
  const wanted = selector.toLowerCase();
  const matches = agents.filter(
    (agent) => agent.name.trim().toLowerCase() === wanted,
  );
  if (matches.length === 1) {
    return { ok: true, agent: matches[0] };
  }
  return matches.length === 0
    ? {
        ok: false,
        reason: "unknown",
        message: `You have no agent named “${selector}”.`,
      }
    : {
        ok: false,
        reason: "ambiguous",
        message: `More than one of your agents is named “${selector}” — link its npub instead.`,
      };
}

/** The owner's dialable agents: kind 30177 registry minus deleted ones. */
export function callableAgentsFromEvents(
  registryEvents: readonly SignedNostrEvent[],
  catalogEvents: readonly SignedNostrEvent[],
  now?: number,
): CallableAgent[] {
  let registry = new Map<string, AgentRegistryEntry>();
  for (const event of registryEvents) {
    const entry = agentFromEvent(event);
    if (entry) registry = mergeAgentEntry(registry, entry);
  }
  let catalogs = new Map<string, DesktopCatalog>();
  for (const event of catalogEvents) {
    const catalog = desktopCatalogFromEvent(event);
    if (catalog) catalogs = mergeDesktopCatalog(catalogs, catalog);
  }
  return selectAvailableCandidates({
    agents: [...registry.values()],
    catalogs: [...catalogs.values()],
    now,
  }).agents.map(({ pubkey, name }) => ({ pubkey, name }));
}

/** A live room in this DM that already has the agent in it, if any. */
export function liveRoomWithAgent(
  lifecycleEvents: readonly SignedNostrEvent[],
  dmChannelId: string,
  agentPubkey: string,
): string | null {
  let rooms: HuddleRoomMap = new Map();
  for (const event of lifecycleEvents) {
    const lifecycle = huddleLifecycleFromEvent(event);
    if (lifecycle) rooms = applyHuddleLifecycle(rooms, lifecycle);
  }
  const agent = agentPubkey.toLowerCase();
  return (
    liveHuddlesFor(rooms, dmChannelId).find((room) =>
      room.participants.some((pubkey) => pubkey.toLowerCase() === agent),
    )?.ephemeralId ?? null
  );
}

type ReadableStorage = Pick<Storage, "getItem">;
type WritableStorage = Pick<Storage, "setItem">;
const HEX64 = /^[0-9a-f]{64}$/;

/** The webview's localStorage, or null where reading it throws. */
export function browserStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** The agent this identity last called, or null (never throws). */
export function readLastCallAgent(
  storage: ReadableStorage | null,
  owner: string | null,
): CallableAgent | null {
  if (!storage || !owner) return null;
  try {
    const raw = storage.getItem(LAST_CALL_AGENT_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      value.owner !== owner.toLowerCase() ||
      typeof value.pubkey !== "string" ||
      !HEX64.test(value.pubkey) ||
      typeof value.name !== "string"
    ) {
      return null;
    }
    return { pubkey: value.pubkey, name: value.name };
  } catch {
    return null;
  }
}

/** Remember a successfully started call for `buzzweb://call` (never throws). */
export function rememberLastCallAgent(
  storage: WritableStorage | null,
  owner: string | null,
  agent: CallableAgent,
): void {
  const pubkey = agent.pubkey.toLowerCase();
  if (!storage || !owner || !HEX64.test(pubkey)) return;
  try {
    storage.setItem(
      LAST_CALL_AGENT_KEY,
      JSON.stringify({ owner: owner.toLowerCase(), pubkey, name: agent.name }),
    );
  } catch {
    // Storage full or blocked: the next call simply has no default.
  }
}

/** True while a tap is recent enough to act on (and not from the future). */
export function isLaunchIntentFresh(
  intent: Pick<LaunchIntent, "createdAt">,
  now: number,
): boolean {
  const age = now - intent.createdAt;
  return (
    Number.isFinite(age) && age <= LAUNCH_INTENT_MAX_AGE_MS && age >= -60_000
  );
}

/** Poll until `ready()` or the timeout; resolves whether it became ready. */
export async function waitUntil(
  ready: () => boolean,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
  intervalMs = 100,
): Promise<boolean> {
  for (let waited = 0; ; waited += intervalMs) {
    if (ready()) return true;
    if (waited >= timeoutMs) return false;
    await sleep(intervalMs);
  }
}

export interface LaunchIntentSource {
  getIntent(): Promise<{ intent: LaunchIntent | null }>;
  acknowledgeIntent(options: { id: string }): Promise<void>;
}

export type LaunchConsumeResult = "none" | "busy" | "stale" | "handled";

/**
 * Consume-once reader for the native pending intent.
 *
 * Each intent id is handled at most once per page and acknowledged exactly
 * once — on success, failure, staleness or a throw — so a crash-free retry of
 * the read (a foreground, a second `launch` event) can never dial twice. The
 * handler receives `acknowledge` to clear the intent early (before dialing,
 * so a relaunch mid-call cannot re-dial); the `finally` covers every other
 * path. A read that arrives mid-handling is replayed once afterwards.
 */
export function createLaunchConsumer({
  source,
  handle,
  now = () => Date.now(),
}: {
  source: LaunchIntentSource;
  handle: (
    intent: LaunchIntent,
    acknowledge: () => Promise<void>,
  ) => Promise<void>;
  now?: () => number;
}): () => Promise<LaunchConsumeResult> {
  const seen = new Set<string>();
  const acked = new Set<string>();
  let busy = false;
  let again = false;
  const acknowledgeOnce = async (id: string) => {
    if (acked.has(id)) return;
    acked.add(id);
    try {
      await source.acknowledgeIntent({ id });
    } catch {
      acked.delete(id); // retried on the next read; the handler never reruns
    }
  };
  const consume = async (): Promise<LaunchConsumeResult> => {
    if (busy) {
      again = true;
      return "busy";
    }
    busy = true;
    try {
      const { intent } = await source.getIntent();
      if (!intent) return "none";
      if (seen.has(intent.id)) {
        await acknowledgeOnce(intent.id);
        return "none";
      }
      seen.add(intent.id);
      try {
        if (!isLaunchIntentFresh(intent, now())) return "stale";
        await handle(intent, () => acknowledgeOnce(intent.id));
        return "handled";
      } finally {
        await acknowledgeOnce(intent.id);
      }
    } finally {
      busy = false;
      if (again) {
        again = false;
        void consume();
      }
    }
  };
  return consume;
}
