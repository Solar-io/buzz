import { Globe, MessageSquare, Pencil } from "lucide-react";
import { useEffect, useState } from "react";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Separator } from "@/shared/ui/separator";
import { Skeleton } from "@/shared/ui/skeleton";
import { useProfileMetadata } from "../hooks.ts";
import { profileLabel, type ProfileDraft } from "../lib/kind0.ts";
import { useProfileActions } from "../ProfileActionsContext.tsx";
import { CopyableNpub } from "./CopyableNpub.tsx";
import { EditProfileForm } from "./EditProfileForm.tsx";
import { ProfileAvatar } from "./ProfileAvatar.tsx";

/**
 * The fuller profile view — the popover's data at reading size.
 *
 * Reached from the card (its header, its "View profile" button, or its "Edit
 * profile" button when the subject is you). It is the same kind-0 read, so
 * nothing here can disagree with the card; the difference is layout and the
 * fields the card has no room for (`website`, the raw key), plus the edit
 * form when the subject is the viewer.
 */
export function ProfileDialog({
  pubkey,
  fallbackLabel,
  picture,
  selfPubkey,
  onOpenDm,
  open,
  onOpenChange,
  startInEdit = false,
}: {
  pubkey: string;
  fallbackLabel: string;
  picture?: string;
  selfPubkey?: string | null;
  onOpenDm?: (pubkey: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Open straight into the edit form. Set by the card's "Edit profile"
   * action, which would otherwise land on the read view and make the user
   * press a second, identically-labelled button. Ignored unless the subject
   * is the viewer.
   */
  startInEdit?: boolean;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-md" data-testid="profile-dialog">
        {open && (
          <ProfileDialogBody
            fallbackLabel={fallbackLabel}
            onOpenChange={onOpenChange}
            onOpenDm={onOpenDm}
            picture={picture}
            pubkey={pubkey}
            selfPubkey={selfPubkey}
            startInEdit={startInEdit}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ProfileDialogBody({
  pubkey,
  fallbackLabel,
  picture,
  selfPubkey,
  onOpenDm,
  onOpenChange,
  startInEdit,
}: {
  pubkey: string;
  fallbackLabel: string;
  picture?: string;
  selfPubkey?: string | null;
  onOpenDm?: (pubkey: string) => void;
  onOpenChange: (open: boolean) => void;
  startInEdit: boolean;
}) {
  const { metadata, rawContent, loading } = useProfileMetadata(pubkey);
  const shellActions = useProfileActions();
  const openDm = onOpenDm ?? shellActions.onOpenDm;

  const isSelf =
    typeof selfPubkey === "string" &&
    selfPubkey.toLowerCase() === pubkey.toLowerCase();

  const [editing, setEditing] = useState(startInEdit && isSelf);

  // Editing is only ever your own profile. If the subject changes under an
  // open dialog, drop straight back to the read view rather than leaving a
  // form pointed at someone else's key.
  useEffect(() => {
    if (!isSelf) {
      setEditing(false);
    }
  }, [isSelf]);

  const label = profileLabel(metadata, fallbackLabel);
  const avatar = metadata.picture || picture;
  const about = metadata.about.trim();
  const website = metadata.website.trim();
  const nip05 = metadata.nip05.trim();

  const initialDraft: ProfileDraft = {
    displayName: metadata.displayName.trim() || metadata.name.trim(),
    about: metadata.about,
    picture: metadata.picture,
  };

  return (
    <>
      <DialogHeader>
        <div className="flex items-center gap-4">
          <ProfileAvatar
            className="h-16 w-16 text-base"
            label={label}
            picture={avatar}
            testId="profile-dialog-avatar"
          />
          <div className="min-w-0 flex-1">
            <DialogTitle
              className="truncate text-lg"
              data-testid="profile-dialog-name"
            >
              {label}
            </DialogTitle>
            <DialogDescription className="sr-only">
              Profile details for {label}
            </DialogDescription>
            {nip05 && (
              <p className="truncate text-xs text-muted-foreground">{nip05}</p>
            )}
            <CopyableNpub className="-ml-1 mt-0.5" pubkey={pubkey} />
          </div>
        </div>
      </DialogHeader>

      {editing ? (
        // The form seeds its draft ONCE from `initial`, so it must not mount
        // before the published kind 0 has arrived — an empty seed would show a
        // blank bio and, on save, publish that emptiness over the real one.
        // Caught in the browser: opening "Edit profile" straight from the card
        // beat the subscription every time.
        loading ? (
          <div
            className="flex flex-col gap-3"
            data-testid="edit-profile-loading"
          >
            <Skeleton className="h-16 w-16 rounded-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : (
          <EditProfileForm
            initial={initialDraft}
            onCancel={() => setEditing(false)}
            onSaved={() => setEditing(false)}
            previousContent={rawContent}
            pubkey={pubkey}
          />
        )
      ) : (
        <div className="flex flex-col gap-4">
          {loading && !about ? (
            <Skeleton className="h-10 w-full" />
          ) : (
            about && (
              <p
                className="whitespace-pre-wrap text-sm leading-5 text-foreground/90"
                data-testid="profile-dialog-about"
              >
                {about}
              </p>
            )
          )}

          {website && (
            <a
              className="inline-flex items-center gap-1.5 self-start text-xs text-primary hover:underline"
              href={website}
              rel="noreferrer noopener"
              target="_blank"
            >
              <Globe aria-hidden className="size-3.5" />
              <span className="truncate">{website}</span>
            </a>
          )}

          <Separator />

          <div className="flex items-center justify-between gap-3">
            <span
              className="truncate font-mono text-2xs text-muted-foreground/70"
              title={pubkey}
            >
              {truncatePubkey(pubkey)}
            </span>
            <div className="flex shrink-0 gap-2">
              {isSelf ? (
                <Button
                  data-testid="profile-dialog-edit"
                  onClick={() => setEditing(true)}
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
                    data-testid="profile-dialog-message"
                    onClick={() => {
                      onOpenChange(false);
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
            </div>
          </div>
        </div>
      )}
    </>
  );
}
