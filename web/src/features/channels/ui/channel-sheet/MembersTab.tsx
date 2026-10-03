import { useRef, useState } from "react";
import { Plus } from "lucide-react";
import { useAgentRegistry } from "@/features/agents/useAgentRegistry";
import {
  useCommunityRoster,
  useMyCommunityRole,
} from "@/features/community-members/hooks";
import { roleOf } from "@/features/community-members/lib/members.ts";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { signNostrEvent } from "@/shared/lib/nostr-signer";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import {
  useChannelMembers,
  useProfiles,
  type ChannelMember,
} from "../../hooks.ts";
import { authorLabel } from "../../lib/authorLabel.ts";
import {
  banTags,
  isLastOwner,
  putUserTags,
  removeUserTags,
  timeoutTags,
  type PeopleRole,
} from "../../lib/channelMemberAdmin.ts";
import { AddPeoplePicker } from "./AddPeoplePicker";
import { CommunityModerationDialog } from "./CommunityModerationDialog";
import { PeopleSection } from "./PeopleSection";
import { AgentMembersSection } from "./AgentMembersSection";
import { partitionChannelMembers } from "../../lib/channelAgents";

/** People management uses relay-confirmed replacement rosters, never optimistic rows. */
export function MembersTab({
  channelId,
  selfPubkey,
  agentPubkeys,
  archived,
}: {
  channelId: string;
  selfPubkey: string | null;
  agentPubkeys: ReadonlySet<string>;
  archived: boolean;
}) {
  const { session } = useRelaySession();
  const members = useChannelMembers(channelId);
  const profiles = useProfiles(members.map((member) => member.pubkey));
  const community = useCommunityRoster();
  const communityRole = useMyCommunityRole(community, selfPubkey);
  const registry = useAgentRegistry();
  const agents = new Set([
    ...agentPubkeys,
    ...registry.map((agent) => agent.pubkey),
    ...members
      .filter((member) => member.role === "bot")
      .map((member) => member.pubkey),
  ]);
  const myRole = members.find((member) => member.pubkey === selfPubkey)?.role;
  const canManage = myRole === "owner" || myRole === "admin";
  const isMember = members.some((member) => member.pubkey === selfPubkey);
  const partition = partitionChannelMembers(members, registry, agents);
  const people = partition.people;
  const [query, setQuery] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [moderation, setModeration] = useState<{
    member: ChannelMember;
    action: "timeout" | "ban";
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const canModerate = (pubkey: string) =>
    !archived &&
    pubkey !== selfPubkey &&
    (communityRole === "owner" ||
      (communityRole === "admin" &&
        !["owner", "admin"].includes(roleOf(community, pubkey) ?? "")));
  const publish = async (kind: number, tags: string[][]) => {
    if (archived) throw new Error("Unarchive the channel to make changes.");
    if (inFlight.current)
      throw new Error("Wait for the current change to finish.");
    inFlight.current = true;
    setBusy(true);
    try {
      const result = await session.publish(
        await signNostrEvent({ kind, tags, content: "" }),
      );
      if (!result.ok)
        throw new Error(result.message || "The relay refused the change.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const run = async (action: () => Promise<void>, message: string) => {
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(message);
    } catch (issue) {
      setError(
        issue instanceof Error ? issue.message : "Could not change the member.",
      );
    }
  };
  const guard = (pubkey: string) => {
    const member = members.find((person) => person.pubkey === pubkey);
    if (!canManage)
      throw new Error(
        "Only channel owners and admins can manage roles and removals.",
      );
    if (!member) throw new Error("This person is no longer in the channel.");
    if (isLastOwner(member, members))
      throw new Error("A channel needs an owner");
  };
  const needle = query.trim().toLowerCase();
  return (
    <div className="space-y-5 pt-5">
      <div className="flex min-w-0 items-center gap-2">
        <Input
          className="min-h-11 min-w-0 flex-1"
          aria-label="Find a member"
          placeholder="Find a member"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {isMember && (
          <Button
            className="min-h-11 shrink-0"
            variant="secondary"
            disabled={busy || archived}
            onClick={() => {
              setError(null);
              setAddOpen(true);
            }}
          >
            <Plus aria-hidden className="size-4" />
            People
          </Button>
        )}
        {isMember && (
          <Button
            className="min-h-11 shrink-0 px-2"
            disabled={busy || archived}
            onClick={() => setAgentOpen(true)}
          >
            <Plus aria-hidden className="size-4" />
            Agent
          </Button>
        )}
      </div>
      {archived && (
        <p className="text-sm text-muted-foreground">
          Unarchive the channel to manage its members.
        </p>
      )}
      {error && !moderation && (
        <p role="alert" className="break-words text-sm text-coral-ink">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-xs text-ink-2">
          {notice}
        </p>
      )}
      <AgentMembersSection
        peopleSection={
          <PeopleSection
            people={people.filter((member) =>
              `${authorLabel(member.pubkey, profiles)} ${member.pubkey} ${member.role ?? "member"}`
                .toLowerCase()
                .includes(needle),
            )}
            allMembers={members}
            profiles={profiles}
            selfPubkey={selfPubkey}
            canManage={canManage}
            canModerate={canModerate}
            busy={busy || archived}
            onRole={(pubkey, role) =>
              void run(async () => {
                guard(pubkey);
                await publish(9000, putUserTags(channelId, pubkey, role));
              }, "Role change accepted. Waiting for the updated member list.")
            }
            onRemove={(member) => {
              if (
                window.confirm(
                  `Remove ${authorLabel(member.pubkey, profiles)} from this channel?`,
                )
              )
                void run(async () => {
                  guard(member.pubkey);
                  await publish(9001, removeUserTags(channelId, member.pubkey));
                }, "Removal accepted. Waiting for the updated member list.");
            }}
            onModerate={(member, action) => {
              setError(null);
              setModeration({ member, action });
            }}
          />
        }
        channelId={channelId}
        members={partition.agents}
        people={people}
        profiles={profiles}
        registry={registry}
        archived={archived}
        canManage={canManage}
        isMember={isMember}
        query={needle}
        pickerOpen={agentOpen}
        onPickerClose={() => setAgentOpen(false)}
      />
      {addOpen && (
        <AddPeoplePicker
          candidates={community.members.map((member) => member.pubkey)}
          memberPubkeys={members.map((member) => member.pubkey)}
          agentPubkeys={agents}
          selfPubkey={selfPubkey}
          canAssignRoles={canManage}
          locked={archived || !isMember}
          onClose={() => setAddOpen(false)}
          onAdd={async (pubkey, role: PeopleRole) => {
            if (!isMember || (!canManage && role !== "member"))
              throw new Error("Your channel role cannot send this invitation.");
            await publish(9000, putUserTags(channelId, pubkey, role));
          }}
        />
      )}
      {moderation && (
        <CommunityModerationDialog
          key={`${moderation.member.pubkey}:${moderation.action}`}
          action={moderation.action}
          label={authorLabel(moderation.member.pubkey, profiles)}
          busy={busy || archived}
          error={error}
          onClose={() => {
            setModeration(null);
            setError(null);
          }}
          onSubmit={(seconds, reason) =>
            void run(
              async () => {
                const { member, action } = moderation;
                if (!canModerate(member.pubkey))
                  throw new Error(
                    "Your community role cannot apply this restriction.",
                  );
                await publish(
                  action === "ban" ? 9040 : 9042,
                  action === "ban"
                    ? banTags(member.pubkey, reason)
                    : timeoutTags(member.pubkey, seconds, reason),
                );
                setModeration(null);
              },
              moderation.action === "ban"
                ? "Community ban accepted."
                : "Community timeout accepted.",
            )
          }
        />
      )}
    </div>
  );
}
