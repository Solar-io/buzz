import { MessageSquare, Pencil, User } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { Skeleton } from "@/shared/ui/skeleton";
import { useProfileMetadata } from "../hooks.ts";
import { profileLabel } from "../lib/kind0.ts";
import { useProfileActions } from "../ProfileActionsContext.tsx";
import { CopyableNpub } from "./CopyableNpub.tsx";
import { ProfileAvatar } from "./ProfileAvatar.tsx";
import { ProfileDialog } from "./ProfileDialog.tsx";

/**
 * The identity card behind every avatar and author name in the timeline.
 *
 * Ported in shape from `desktop/src/features/profile/ui/UserProfilePopover.tsx`
 * and deliberately smaller than it. The desktop card fans out to seven
 * queries — presence, user status, relay agents, managed agents, NIP-OA
 * ownership, agent working-state — because the desktop client has all of
 * those features. The web client has none of them yet, so this carries the
 * four things it can actually answer: who this is, their npub, their bio, and
 * the two actions that exist (message them, or edit yourself).
 *
 * Two structural details are kept from the desktop because they are not
 * cosmetic:
 *
 * - The body is mounted only while the card is open. It holds a relay
 *   subscription; an eager body would open one REQ per rendered message.
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
  /**
   * Open a DM with this person. Falls back to
   * {@link useProfileActions}'s shell-provided handler; when neither is set
   * the action is not rendered at all.
   */
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
  // An explicit prop wins over the shell's provider, so a caller that already
  // holds the handler need not depend on the context being mounted.
  const openDm = onOpenDm ?? shellActions.onOpenDm;

  const label = profileLabel(metadata, fallbackLabel);
  const avatar = metadata.picture || picture;
  const about = metadata.about.trim();
  const isSelf =
    typeof selfPubkey === "string" &&
    selfPubkey.toLowerCase() === pubkey.toLowerCase();

  return (
    <PopoverContent
      align="start"
      className="w-72 p-3"
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
          <ProfileAvatar
            className="h-10 w-10 text-sm"
            label={label}
            picture={avatar}
            testId="user-profile-popover-avatar"
          />
          <span className="min-w-0 flex-1">
            <span
              className="block truncate text-sm font-semibold"
              data-testid="user-profile-popover-name"
            >
              {label}
            </span>
            {metadata.nip05.trim() && (
              <span className="block truncate text-2xs text-muted-foreground">
                {metadata.nip05.trim()}
              </span>
            )}
          </span>
        </button>

        <CopyableNpub className="-ml-1 self-start" pubkey={pubkey} />

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

        <div className="flex gap-2">
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
            openDm && (
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
            )
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
