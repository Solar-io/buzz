import { MessageSquare, Pencil, User } from "lucide-react";
import { useState, type ReactNode } from "react";

import { PresenceAvatarDot } from "@/features/presence/ui/PresenceBadge";
import { usePresenceStatus } from "@/features/presence/hooks";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { Skeleton } from "@/shared/ui/skeleton";

import { useProfileMetadata } from "../hooks.ts";
import { profileLabel } from "../lib/kind0.ts";
import { labelledName } from "../lib/userLabels.ts";
import { useProfileActions } from "../ProfileActionsContext.tsx";
import { useFollow, useOwnContactList } from "../useContacts.ts";
import { useUserLabels } from "../useUserLabels.ts";
import { CopyableNpub } from "./CopyableNpub.tsx";
import { ProfileAvatar } from "./ProfileAvatar.tsx";
import { ProfileDialog } from "./ProfileDialog.tsx";
import {
  CommunityRoleRow,
  FollowButton,
  Nip05Row,
  PresenceStatusRow,
} from "./ProfileIdentityRows.tsx";

/**
 * The identity card behind every avatar and author name in the timeline.
 *
 * Ported in shape from `desktop/src/features/profile/ui/UserProfilePopover.tsx`
 * and still smaller than it — the desktop card also carries managed-agent
 * controls, persona actions and agent working-state, none of which exist in
 * the browser client. What it now answers that it did not before: whether the
 * person is here (presence), what they said they are doing (kind:30315),
 * whether their domain agrees with their handle (NIP-05), what they can do in
 * this community (kind:13534), and whether you follow them (kind:3).
 *
 * Two structural details are kept from the desktop because they are not
 * cosmetic:
 *
 * - The body is mounted only while the card is open. It holds several relay
 *   subscriptions; an eager body would open them per rendered message.
 * - Opening is a *click*, not a hover. The desktop opens on dwell; on the web
 *   the same trigger has to work on touch, where there is no hover.
 */
export function UserProfilePopover({
  pubkey,
  fallbackLabel,
  picture,
  selfPubkey,
  onOpenDm,
  triggerClassName,
  triggerAriaLabel,
  children,
}: {
  pubkey: string;
  /** Name the timeline already resolved — shown before kind 0 arrives. */
  fallbackLabel: string;
  /** Avatar the timeline already resolved, for the same reason. */
  picture?: string;
  /** The viewer's key; when it matches, the card offers editing instead. */
  selfPubkey?: string | null;
  onOpenDm?: (pubkey: string) => void;
  triggerClassName?: string;
  triggerAriaLabel?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  // Which view the dialog opens on. "Edit profile" must land in the form; the
  // header and "View profile" land on the read view.
  const [dialogStartsInEdit, setDialogStartsInEdit] = useState(false);
  const openDialog = (editing: boolean) => {
    setOpen(false);
    setDialogStartsInEdit(editing);
    setDialogOpen(true);
  };

  return (
    <>
      <Popover onOpenChange={setOpen} open={open}>
        <PopoverTrigger asChild>
          <button
            aria-label={triggerAriaLabel ?? `Open profile for ${fallbackLabel}`}
            className={cn(
              "rounded-md text-left focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring",
              triggerClassName,
            )}
            data-testid={`profile-trigger-${pubkey}`}
            type="button"
          >
            {children}
          </button>
        </PopoverTrigger>
        {open && (
          <UserProfilePopoverBody
            fallbackLabel={fallbackLabel}
            onOpenDm={onOpenDm}
            onOpenFullProfile={openDialog}
            picture={picture}
            pubkey={pubkey}
            selfPubkey={selfPubkey}
            setOpen={setOpen}
          />
        )}
      </Popover>
      <ProfileDialog
        fallbackLabel={fallbackLabel}
        onOpenChange={setDialogOpen}
        onOpenDm={onOpenDm}
        open={dialogOpen}
        picture={picture}
        pubkey={pubkey}
        selfPubkey={selfPubkey}
        startInEdit={dialogStartsInEdit}
      />
    </>
  );
}

function UserProfilePopoverBody({
  fallbackLabel,
  onOpenDm,
  onOpenFullProfile,
  picture,
  pubkey,
  selfPubkey,
  setOpen,
}: {
  fallbackLabel: string;
  onOpenDm?: (pubkey: string) => void;
  /** Raise the fuller view; `true` opens it straight into the edit form. */
  onOpenFullProfile: (editing: boolean) => void;
  picture?: string;
  pubkey: string;
  selfPubkey?: string | null;
  setOpen: (open: boolean) => void;
}) {
  const { metadata, loading } = useProfileMetadata(pubkey);
  const shellActions = useProfileActions();
  const { labels } = useUserLabels();
  const presence = usePresenceStatus(pubkey);
  const contacts = useOwnContactList(selfPubkey);
  const follow = useFollow(contacts, selfPubkey, pubkey);
  // An explicit prop wins over the shell's provider, so a caller that already
  // holds the handler need not depend on the context being mounted.
  const openDm = onOpenDm ?? shellActions.onOpenDm;

  const published = profileLabel(metadata, fallbackLabel);
  const label = labelledName(labels, pubkey, published, fallbackLabel);
  const avatar = metadata.picture || picture;
  const about = metadata.about.trim();
  const isSelf =
    typeof selfPubkey === "string" &&
    selfPubkey.toLowerCase() === pubkey.toLowerCase();

  return (
    <PopoverContent
      align="start"
      className="w-80 p-3"
      data-testid="user-profile-popover"
      // A card raised from a message row must not steal focus into its first
      // button — that reads as if the button were already chosen. Tab still
      // enters normally.
      onOpenAutoFocus={(event) => event.preventDefault()}
      side="top"
      sideOffset={8}
    >
      <div className="flex flex-col gap-3">
        <button
          className="flex w-full min-w-0 items-center gap-3 rounded-lg text-left focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
          data-testid="profile-open-full"
          onClick={() => onOpenFullProfile(false)}
          type="button"
        >
          <span className="relative shrink-0">
            <ProfileAvatar
              className="size-10 text-sm"
              label={label}
              picture={avatar}
              testId="user-profile-popover-avatar"
            />
            <PresenceAvatarDot status={presence} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2">
              <span
                className="min-w-0 truncate text-sm font-semibold"
                data-testid="user-profile-popover-name"
              >
                {label}
              </span>
              <CommunityRoleRow pubkey={pubkey} />
            </span>
            <Nip05Row claim={metadata.nip05} pubkey={pubkey} />
          </span>
        </button>

        <CopyableNpub className="-ml-1 self-start" pubkey={pubkey} />

        <PresenceStatusRow pubkey={pubkey} />

        {loading && !about ? (
          <Skeleton className="h-4 w-40" />
        ) : (
          about && (
            <p
              className="line-clamp-3 text-xs leading-4 text-muted-foreground"
              data-testid="user-profile-popover-about"
            >
              {about}
            </p>
          )
        )}

        <div className="flex flex-wrap gap-2">
          {isSelf ? (
            <Button
              className="min-w-0 flex-1"
              data-testid="user-profile-popover-edit"
              onClick={() => onOpenFullProfile(true)}
              size="sm"
              type="button"
              variant="outline"
            >
              <Pencil aria-hidden />
              Edit profile
            </Button>
          ) : (
            <>
              {openDm && (
                <Button
                  className="min-w-0 flex-1"
                  data-testid="user-profile-popover-message"
                  onClick={() => {
                    setOpen(false);
                    openDm(pubkey);
                  }}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <MessageSquare aria-hidden />
                  Message
                </Button>
              )}
              <FollowButton
                className="min-w-0 flex-1"
                following={follow.following}
                onToggle={follow.toggle}
                pending={follow.pending}
                ready={follow.ready}
              />
            </>
          )}
          <Button
            className="min-w-0 flex-1"
            data-testid="user-profile-popover-view"
            onClick={() => onOpenFullProfile(false)}
            size="sm"
            type="button"
            variant="ghost"
          >
            <User aria-hidden />
            View profile
          </Button>
        </div>
      </div>
    </PopoverContent>
  );
}
