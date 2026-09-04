/**
 * Adding an agent to a live huddle, from a browser.
 *
 * REACHABILITY, first, because the previous wave assumed this needed ACP
 * lifecycle commands the web has no access to. It does not — and the desktop
 * says so in its own module header:
 *
 *   "ACP spawning is NOT needed here: the running agent process
 *    auto-subscribes when it receives the kind:9000 membership notification."
 *   — desktop/src-tauri/src/huddle/agents.rs:8-10
 *
 * `add_agent_to_huddle` (agents.rs:94-140) is, end to end, two Nostr events:
 *
 *   1. kind 9000 add-member on the EPHEMERAL channel, role `bot` — required,
 *      fails hard (agents.rs:101-103).
 *   2. kind 9000 add-member on the PARENT channel, role `bot` — best effort,
 *      and SKIPPED when the agent is already a parent member of any role
 *      (agents.rs:110-118). Rewriting an existing member as `bot` is
 *      "unnecessary and forbidden for non-admins", so the skip is not an
 *      optimisation, it is what keeps a non-admin's add from being rejected.
 *
 * Both are `build_add_member` (desktop/src-tauri/src/events.rs:222) — tags
 * `["h", channel]`, `["p", pubkey]`, `["role", "bot"]` — a shape the web
 * client already publishes for channel templates
 * (web/src/features/channel-templates/lib/applyTemplate.ts:79).
 *
 * WHAT THE BROWSER STILL CANNOT DO, and this is the honest difference from
 * the desktop dialog:
 *
 *  - `list_managed_agents` (a Tauri command reading the local managed-agent
 *    store) has no browser equivalent, so the picker is sourced from the
 *    owner's kind-30177 registry instead. Same agents, published projection.
 *  - `start_managed_agent` cannot run in a browser — the process lives on a
 *    desktop. The web's remote equivalent is the owner-sealed kind-24201
 *    admin command `{action:"start"}`
 *    (web/src/features/agents/lib/adminCommands.ts:85), which the OWNER'S
 *    desktop applies through its own path. So a stopped agent can be started
 *    from the browser, but only the owner's own, and only while a desktop of
 *    theirs is running to apply it — which is why {@link huddleAgentAddPlan}
 *    reports the start as a separate, optional step rather than folding it in.
 *  - There is no per-agent running/stopped signal on the wire (kind 30180
 *    lists which machine CLAIMS an agent, not whether its process is up), so
 *    the browser cannot pre-filter to "running" the way the desktop dialog
 *    does. It offers the start command unconditionally instead.
 *
 * Import-free apart from sibling `.ts` modules, so `node --test` loads it.
 */

/** `MAX_HUDDLE_AGENTS` — desktop/src-tauri/src/huddle/relay_api.rs:23. */
export const MAX_HUDDLE_AGENTS = 20;

/** `KIND_NIP29_PUT_USER` — crates/buzz-core/src/kind.rs:352. */
export const ADD_MEMBER_KIND = 9000;

const PUBKEY_RE = /^[0-9a-f]{64}$/;

export interface UnsignedAddMemberEvent {
  kind: number;
  tags: string[][];
  content: string;
}

/**
 * One kind-9000 add-member event, role `bot`.
 *
 * The role tag is always present here — unlike the generic builder in
 * `channel-templates`, which omits `member` because that is the relay's
 * default. `bot` is never the default and is precisely what makes the agent
 * discoverable as a huddle agent afterwards (the TTS gate and the desktop's
 * `fetch_channel_members(.., Some("bot"), ..)` both key on it).
 */
export function buildHuddleAgentAddEvent(input: {
  channelId: string;
  agentPubkey: string;
}): { event: UnsignedAddMemberEvent } | { error: string } {
  const pubkey = input.agentPubkey.toLowerCase();
  if (!PUBKEY_RE.test(pubkey)) {
    return { error: "agent pubkey must be 64 hex characters" };
  }
  if (input.channelId.length === 0) {
    return { error: "channel id is required" };
  }
  return {
    event: {
      kind: ADD_MEMBER_KIND,
      tags: [
        ["h", input.channelId],
        ["p", pubkey],
        ["role", "bot"],
      ],
      content: "",
    },
  };
}

export interface HuddleAgentAddPlan {
  /** Always present — the required, fail-hard step. */
  ephemeral: UnsignedAddMemberEvent;
  /**
   * The best-effort parent add, or null when the agent is already a parent
   * member. Null is a deliberate skip, not a failure: see the module note.
   */
  parent: UnsignedAddMemberEvent | null;
}

/**
 * The full add, as events, so the exact wire shape is pinned by a test rather
 * than read out of a relay log.
 *
 * Refuses rather than plans when the huddle is already at capacity, matching
 * `add_agent_to_huddle`'s incremental cap check
 * (desktop/src-tauri/src/huddle/commands.rs:166-172) — the relay does not
 * enforce this, so a client that skips it simply overfills the room.
 */
export function huddleAgentAddPlan(input: {
  ephemeralChannelId: string;
  parentChannelId: string | null;
  agentPubkey: string;
  /** Bot members already in the ephemeral channel. */
  currentAgentPubkeys: readonly string[];
  /** Every member of the parent channel, any role. */
  parentMemberPubkeys: readonly string[];
}): { plan: HuddleAgentAddPlan } | { error: string } {
  const pubkey = input.agentPubkey.toLowerCase();
  const current = input.currentAgentPubkeys.map((key) => key.toLowerCase());
  if (current.includes(pubkey)) {
    return { error: "that agent is already in this huddle" };
  }
  if (current.length >= MAX_HUDDLE_AGENTS) {
    return {
      error: `agent limit reached: ${current.length} (max ${MAX_HUDDLE_AGENTS})`,
    };
  }
  const ephemeral = buildHuddleAgentAddEvent({
    channelId: input.ephemeralChannelId,
    agentPubkey: pubkey,
  });
  if ("error" in ephemeral) {
    return { error: ephemeral.error };
  }

  if (input.parentChannelId === null || input.parentChannelId.length === 0) {
    return { plan: { ephemeral: ephemeral.event, parent: null } };
  }
  const alreadyInParent = input.parentMemberPubkeys.some(
    (key) => key.toLowerCase() === pubkey,
  );
  if (alreadyInParent) {
    return { plan: { ephemeral: ephemeral.event, parent: null } };
  }
  const parent = buildHuddleAgentAddEvent({
    channelId: input.parentChannelId,
    agentPubkey: pubkey,
  });
  if ("error" in parent) {
    return { plan: { ephemeral: ephemeral.event, parent: null } };
  }
  return { plan: { ephemeral: ephemeral.event, parent: parent.event } };
}

/** The minimum an agent needs to be offered in the picker. */
export interface SelectableAgent {
  pubkey: string;
  name: string;
}

/**
 * The agents a user may still add: the owner's registry minus whoever is
 * already a bot in this huddle, name-sorted.
 *
 * Registry entries with a malformed pubkey are dropped rather than offered —
 * the relay would reject the add and the row would be a dead button.
 */
export function selectableHuddleAgents(
  registry: readonly SelectableAgent[],
  currentAgentPubkeys: readonly string[],
): SelectableAgent[] {
  const present = new Set(
    currentAgentPubkeys.map((pubkey) => pubkey.toLowerCase()),
  );
  return registry
    .filter((agent) => PUBKEY_RE.test(agent.pubkey.toLowerCase()))
    .filter((agent) => !present.has(agent.pubkey.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Message for the result of one add, so the UI does not have to reconstruct
 * the desktop's three-way outcome (`AgentAddResult`, agents.rs:63-71) from
 * two booleans at the call site.
 */
export function huddleAgentAddMessage(input: {
  agentName: string;
  parentAttempted: boolean;
  parentOk: boolean;
  parentMessage?: string;
}): string {
  if (!input.parentAttempted || input.parentOk) {
    return `${input.agentName} added to the huddle.`;
  }
  const detail = input.parentMessage?.trim();
  return detail
    ? `${input.agentName} added to the huddle, but the channel add failed: ${detail}`
    : `${input.agentName} added to the huddle, but the channel add failed.`;
}
