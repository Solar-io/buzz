/**
 * Adding members to a channel from the browser — the pure half.
 *
 * DESKTOP PARITY, measured before this existed: the desktop's
 * `add_channel_members` command (desktop/src-tauri/src/commands/channels.rs)
 * publishes **one kind-9000 event per member**, sequentially, and keeps going
 * when one is refused, collecting per-member errors into
 * `{added, errors}`. It never sends a bulk event with many `p` tags — relay
 * membership semantics are per-`p`, so a bulk event would at best add one
 * member. Event shape (desktop `events.rs:222` build_add_member): tags
 * `["h", channel]`, `["p", lowercase pubkey]`, and a `role` tag only when the
 * role is not `member` — `Some("member") | None` map to no tag at all.
 * Humans are added role-less; registered agents get `bot` (desktop keys this
 * off `user.isAgent`; the web registry is the same signal).
 *
 * The builder itself is REUSED, not duplicated, from channel-templates
 * (`buildAddMemberEvent`) — it already pins exactly this wire shape, and the
 * huddle flow re-derived it once before, which is one copy more than the
 * primitive deserves.
 *
 * After a successful add the roster refreshes itself: the relay republishes
 * the channel's kind-39002 members event on any membership change
 * (`store_group_members_event` + `dispatch_group_members_event`,
 * crates/buzz-relay/src/handlers/side_effects.rs), and `useChannelMembers`
 * holds a live 39002 subscription — no polling, no refetch.
 *
 * Import-free apart from sibling/relative `.ts` modules, so `node --test`
 * loads it.
 */

import type { AgentRegistryEntry } from "../../agents/lib/agentRegistry.ts";
import { buildAddMemberEvent } from "../../channel-templates/lib/applyTemplate.ts";
import type { UnsignedEventTemplate } from "../../channel-templates/lib/applyTemplate.ts";

export type MemberAddRole = "admin" | "bot" | "guest" | "member";

export interface MemberAddFailure {
  pubkey: string;
  message: string;
}

export interface AddMembersOutcome {
  added: string[];
  failures: MemberAddFailure[];
}

/** A publish-shaped async step, injected so tests can count calls. */
export type MemberEventSender = (
  event: UnsignedEventTemplate,
) => Promise<{ ok: boolean; message: string }>;

/**
 * The suggestion sources minus everyone already in the channel.
 *
 * Filtering happens on the SOURCES rather than the built list so
 * `buildDmSuggestions` keeps owning merge, dedupe, and stale-demotion — an
 * agent who is also a current member must vanish from both lists, not just
 * one. A roster key that is neither a registered agent nor a DM contact (a
 * stranger someone pasted earlier) is simply not in the sources anyway.
 */
export function excludeCurrentMembers({
  agents,
  contacts,
  memberPubkeys,
}: {
  agents: AgentRegistryEntry[];
  contacts: string[];
  memberPubkeys: readonly string[];
}): { agents: AgentRegistryEntry[]; contacts: string[] } {
  const members = new Set(memberPubkeys.map((pubkey) => pubkey.toLowerCase()));
  return {
    agents: agents.filter((agent) => !members.has(agent.pubkey.toLowerCase())),
    contacts: contacts.filter((pubkey) => !members.has(pubkey.toLowerCase())),
  };
}

/**
 * Publish the adds, one event per member, in order — the desktop's loop,
 * browser-side. A refused add does not stop the others; every refusal keeps
 * the relay's own message, which names the rule that was broken and is what
 * the UI surfaces.
 */
export async function publishChannelMemberAdds({
  channelId,
  members,
  send,
}: {
  channelId: string;
  members: ReadonlyArray<{ pubkey: string; role: MemberAddRole }>;
  send: MemberEventSender;
}): Promise<AddMembersOutcome> {
  const added: string[] = [];
  const failures: MemberAddFailure[] = [];
  for (const member of members) {
    const built = buildAddMemberEvent({
      channelId,
      pubkey: member.pubkey,
      role: member.role,
    });
    if ("error" in built) {
      // Malformed key: refused before the wire, same as the desktop's
      // per-iteration build failure.
      failures.push({ pubkey: member.pubkey, message: built.error });
      continue;
    }
    const result = await send(built.event);
    if (result.ok) {
      added.push(member.pubkey);
    } else {
      failures.push({
        pubkey: member.pubkey,
        message: result.message || "The relay refused the add.",
      });
    }
  }
  return { added, failures };
}

/**
 * The role a candidate is added with: registered agents ride as `bot` (what
 * makes them discoverable as agents afterwards), everyone else is added
 * role-less (`member` is the relay's default and builds to no tag).
 */
export function memberAddRoleFor(
  pubkey: string,
  agents: AgentRegistryEntry[],
): MemberAddRole {
  return agents.some(
    (agent) => agent.pubkey.toLowerCase() === pubkey.toLowerCase(),
  )
    ? "bot"
    : "member";
}
