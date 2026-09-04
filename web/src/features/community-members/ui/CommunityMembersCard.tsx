import { Plus, Search, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { useProfiles } from "@/features/channels/hooks";
import { usePresenceMap } from "@/features/presence/hooks";
import { ownPubkey } from "@/shared/lib/nostr-signer";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";

import {
  useCommunityRoster,
  useMemberActions,
  useMyCommunityRole,
  useNewJoiners,
} from "../hooks.ts";
import {
  canAddMembers,
  filterMembers,
  sortMembers,
  type CommunityMember,
} from "../lib/members.ts";
import { AddMemberDialog } from "./AddMemberDialog.tsx";
import { ConfirmRemoveDialog } from "./ConfirmRemoveDialog.tsx";
import { InviteLinkSection } from "./InviteLinkSection.tsx";
import { MemberRow } from "./MemberRow.tsx";

/**
 * The community roster screen.
 *
 * Everything here reads the relay's own kind-13534 snapshot and writes with
 * kinds 9030/9031/9032 — no privileged transport, no desktop-only backend. The
 * one HTTP call is the invite mint, and only because the relay returns a code
 * that no fire-and-forget publish could hand back.
 *
 * Roles the viewer does not hold produce no controls at all: the capability
 * matrix mirrors `relay_admin.rs`, so a member sees a read-only roster and an
 * admin sees exactly the subset the relay will honour.
 */
export function CommunityMembersCard() {
  const [selfPubkey, setSelfPubkey] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void ownPubkey().then((pubkey) => {
      if (!cancelled) {
        setSelfPubkey(pubkey);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const roster = useCommunityRoster();
  const viewerRole = useMyCommunityRole(roster, selfPubkey);
  const actions = useMemberActions();
  const canManage = canAddMembers(viewerRole);
  const { joined, dismiss } = useNewJoiners(roster, selfPubkey, canManage);

  const [query, setQuery] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<CommunityMember | null>(
    null,
  );
  const [busyPubkey, setBusyPubkey] = useState<string | null>(null);

  const pubkeys = useMemo(
    () => roster.members.map((member) => member.pubkey),
    [roster.members],
  );
  const profiles = useProfiles(pubkeys);
  // Presence for the whole roster: one author-scoped REQ, capped because a
  // relay REQ carries a finite author list and a 500-person community would
  // otherwise ask for all of them at once.
  const presenceSubjects = useMemo(() => pubkeys.slice(0, 128), [pubkeys]);
  const presence = usePresenceMap(presenceSubjects);

  const nameFor = (pubkey: string) =>
    profiles.get(pubkey)?.displayName || truncatePubkey(pubkey);

  const visible = useMemo(
    () =>
      sortMembers(
        filterMembers(
          roster.members,
          query,
          (pubkey) => profiles.get(pubkey)?.displayName,
        ),
      ),
    [roster.members, query, profiles],
  );

  const changeRole = async (
    member: CommunityMember,
    role: "admin" | "member",
  ) => {
    setBusyPubkey(member.pubkey);
    try {
      await actions.changeRole({ pubkey: member.pubkey, role });
      toast.success(
        role === "admin"
          ? `${nameFor(member.pubkey)} is now an admin`
          : `${nameFor(member.pubkey)} is now a member`,
      );
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "The relay refused the change.",
      );
    } finally {
      setBusyPubkey(null);
    }
  };

  return (
    <section
      className="space-y-3 rounded-lg border border-border bg-card p-4"
      data-testid="community-members"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 font-medium">
            <Users aria-hidden className="size-4 text-muted-foreground" />
            Community members
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {roster.loaded
              ? roster.members.length > 0
                ? `${roster.members.length} ${roster.members.length === 1 ? "person" : "people"} can reach this relay.`
                : "This relay publishes no membership list — it is open to anyone who can reach it."
              : "Reading the membership list…"}
          </p>
        </div>
        {canManage ? (
          <Button
            data-testid="community-members-add"
            onClick={() => setAddOpen(true)}
            size="sm"
            type="button"
          >
            <Plus aria-hidden />
            Add
          </Button>
        ) : null}
      </div>

      {joined.length > 0 ? (
        <div
          className="flex items-center justify-between gap-3 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2"
          data-testid="community-new-joiners"
        >
          <p className="min-w-0 text-sm">
            <span className="font-medium">
              {joined.length === 1
                ? `${nameFor(joined[0])} joined`
                : `${joined.length} people joined`}
            </span>{" "}
            <span className="text-muted-foreground">
              since you last looked.
            </span>
          </p>
          <Button onClick={dismiss} size="sm" type="button" variant="ghost">
            Dismiss
          </Button>
        </div>
      ) : null}

      {roster.members.length > 0 ? (
        <>
          <div className="relative">
            <Search
              aria-hidden
              className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              aria-label="Filter members"
              className="pl-8"
              data-testid="community-members-filter"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter by name, role, or key"
              value={query}
            />
          </div>

          <ul className="space-y-2" data-testid="community-members-list">
            {visible.map((member) => (
              <MemberRow
                avatarUrl={profiles.get(member.pubkey)?.avatar}
                busy={busyPubkey === member.pubkey}
                displayName={nameFor(member.pubkey)}
                isSelf={selfPubkey?.toLowerCase() === member.pubkey}
                key={member.pubkey}
                member={member}
                onChangeRole={(target, role) => void changeRole(target, role)}
                onRemove={setRemoveTarget}
                presence={presence.get(member.pubkey)?.status ?? "unknown"}
                viewerRole={viewerRole}
              />
            ))}
          </ul>

          {visible.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nobody matches “{query.trim()}”.
            </p>
          ) : null}

          {roster.asOf !== null ? (
            <p className="text-2xs text-muted-foreground/70">
              Roster as published by the relay on{" "}
              {new Date(roster.asOf * 1000).toLocaleString()}. The membership
              list carries no per-person join date.
            </p>
          ) : null}
        </>
      ) : null}

      {canManage ? <InviteLinkSection /> : null}

      <AddMemberDialog
        onAdd={actions.addMember}
        onOpenChange={setAddOpen}
        open={addOpen}
        roster={roster}
        viewerRole={viewerRole}
      />
      <ConfirmRemoveDialog
        displayName={removeTarget ? nameFor(removeTarget.pubkey) : ""}
        member={removeTarget}
        onConfirm={actions.removeMember}
        onOpenChange={(open) => {
          if (!open) {
            setRemoveTarget(null);
          }
        }}
      />
    </section>
  );
}
