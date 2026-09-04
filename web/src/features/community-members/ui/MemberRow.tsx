import { MoreHorizontal } from "lucide-react";

import { CopyableNpub } from "@/features/profile/ui/CopyableNpub";
import { ProfileAvatar } from "@/features/profile/ui/ProfileAvatar";
import { PresenceAvatarDot } from "@/features/presence/ui/PresenceBadge";
import type { ObservedPresenceStatus } from "@/features/presence/lib/presenceStatus";
import { Button } from "@/shared/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";

import {
  communityMemberCapability,
  type CommunityMember,
  type CommunityRole,
} from "../lib/members.ts";
import { RoleBadge } from "./RoleBadge.tsx";

/**
 * One roster row.
 *
 * The action menu renders only when the viewer can actually do something to
 * this person — see `communityMemberCapability`, which mirrors the relay's
 * per-kind rules. An always-visible menu whose every item is disabled tells
 * the user nothing except that the app is confused about who they are.
 */
export function MemberRow({
  member,
  displayName,
  avatarUrl,
  presence,
  viewerRole,
  isSelf,
  busy,
  onRemove,
  onChangeRole,
}: {
  member: CommunityMember;
  displayName: string;
  avatarUrl?: string;
  presence: ObservedPresenceStatus;
  viewerRole: CommunityRole | null;
  isSelf: boolean;
  busy: boolean;
  onRemove: (member: CommunityMember) => void;
  onChangeRole: (member: CommunityMember, role: "admin" | "member") => void;
}) {
  const capability = communityMemberCapability({
    viewerRole,
    targetRole: member.role,
    targetIsSelf: isSelf,
  });
  const hasActions =
    capability.canRemove ||
    capability.canPromoteToAdmin ||
    capability.canDemoteToMember;

  return (
    <li
      className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-background/60 px-3 py-2"
      data-testid={`community-member-${member.pubkey}`}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="relative shrink-0">
          <ProfileAvatar
            className="size-8 text-2xs"
            label={displayName}
            picture={avatarUrl}
          />
          <PresenceAvatarDot status={presence} />
        </span>
        <span className="min-w-0">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium">{displayName}</span>
            <RoleBadge role={member.role} />
            {isSelf ? (
              <span className="shrink-0 text-2xs text-muted-foreground">
                you
              </span>
            ) : null}
          </span>
          <CopyableNpub className="-ml-1" pubkey={member.pubkey} />
        </span>
      </div>

      {hasActions ? (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label={`Actions for ${displayName}`}
              data-testid={`community-member-actions-${member.pubkey}`}
              disabled={busy}
              size="icon"
              type="button"
              variant="ghost"
            >
              <MoreHorizontal aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {capability.canPromoteToAdmin ? (
              <DropdownMenuItem
                data-testid={`community-member-promote-${member.pubkey}`}
                onClick={() => onChangeRole(member, "admin")}
              >
                Make admin
              </DropdownMenuItem>
            ) : null}
            {capability.canDemoteToMember ? (
              <DropdownMenuItem
                data-testid={`community-member-demote-${member.pubkey}`}
                onClick={() => onChangeRole(member, "member")}
              >
                Make member
              </DropdownMenuItem>
            ) : null}
            {capability.canRemove &&
            (capability.canPromoteToAdmin || capability.canDemoteToMember) ? (
              <DropdownMenuSeparator />
            ) : null}
            {capability.canRemove ? (
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                data-testid={`community-member-remove-${member.pubkey}`}
                onClick={() => onRemove(member)}
              >
                Remove from community
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </li>
  );
}
