import { useState } from "react";
import { toast } from "sonner";

import { CopyableNpub } from "@/features/profile/ui/CopyableNpub";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";

import type { CommunityMember } from "../lib/members.ts";

/**
 * Confirm a removal.
 *
 * Removal revokes relay access, which on a closed relay means the person can
 * no longer read anything — so it gets a confirmation naming the person, and
 * the full npub is on screen while the operator decides. A truncated key is a
 * recognition aid, and this is the one moment it is not good enough.
 */
export function ConfirmRemoveDialog({
  member,
  displayName,
  onOpenChange,
  onConfirm,
}: {
  member: CommunityMember | null;
  displayName: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: (pubkey: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    if (!member) {
      return;
    }
    setBusy(true);
    try {
      await onConfirm(member.pubkey);
      toast.success(`${displayName} removed`);
      onOpenChange(false);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "The relay refused the removal.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={member !== null}>
      <DialogContent className="max-w-sm" data-testid="confirm-remove-dialog">
        <DialogHeader>
          <DialogTitle>Remove {displayName}?</DialogTitle>
          <DialogDescription>
            This revokes their access to the relay immediately. They can be
            added back, or use an invite link.
          </DialogDescription>
        </DialogHeader>
        {member ? <CopyableNpub pubkey={member.pubkey} /> : null}
        <div className="flex justify-end gap-2">
          <Button
            onClick={() => onOpenChange(false)}
            size="sm"
            type="button"
            variant="ghost"
          >
            Cancel
          </Button>
          <Button
            data-testid="confirm-remove-submit"
            disabled={busy || member === null}
            onClick={() => void confirm()}
            size="sm"
            type="button"
            variant="destructive"
          >
            {busy ? "Removing…" : "Remove"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
