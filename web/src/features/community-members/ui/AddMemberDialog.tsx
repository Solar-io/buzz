import { useEffect, useId, useMemo, useState } from "react";
import { toast } from "sonner";

import { useProfiles } from "@/features/channels/hooks";
import { ProfileAvatar } from "@/features/profile/ui/ProfileAvatar";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";

import {
  assignableRoles,
  isAlreadyMember,
  type CommunityRole,
  type CommunityRoster,
} from "../lib/members.ts";
import { parsePubkeyInput } from "../lib/pubkeyInput.ts";
import { ROLE_LABEL } from "./RoleBadge.tsx";

type AssignableRole = Exclude<CommunityRole, "owner">;

/**
 * Add somebody by key.
 *
 * The web client has no user-directory endpoint — the desktop's search box is
 * backed by a Tauri `search_users` command over its local profile store — so
 * this takes a key and *resolves* it, rather than searching. That is the
 * honest shape for the browser: the field accepts an npub, an nprofile, a
 * `nostr:` URI or raw hex, and the resolved profile (name and avatar, from
 * kind 0) is shown before the add so the operator can see who they are about
 * to admit. A key with no published profile still resolves — it just shows as
 * its truncated form, which is exactly what the roster will show too.
 */
export function AddMemberDialog({
  open,
  onOpenChange,
  roster,
  viewerRole,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roster: CommunityRoster;
  viewerRole: CommunityRole | null;
  onAdd: (input: { pubkey: string; role: AssignableRole }) => Promise<void>;
}) {
  const fieldId = useId();
  const [entry, setEntry] = useState("");
  const [role, setRole] = useState<AssignableRole>("member");
  const [busy, setBusy] = useState(false);

  const roles = useMemo(
    () => assignableRoles(viewerRole).filter((value) => value !== "owner"),
    [viewerRole],
  ) as AssignableRole[];

  useEffect(() => {
    if (open) {
      setEntry("");
      setRole("member");
      setBusy(false);
    }
  }, [open]);

  const parsed = parsePubkeyInput(entry);
  const already = parsed !== null && isAlreadyMember(roster, parsed);
  // One subscription, and only while the field holds a real key.
  const lookupKeys = useMemo(() => (parsed ? [parsed] : []), [parsed]);
  const profiles = useProfiles(lookupKeys);
  const resolvedName = (parsed ? profiles.get(parsed)?.displayName : "") || "";

  const canAdd = parsed !== null && !already && !busy;

  const submit = async () => {
    if (!parsed || !canAdd) {
      return;
    }
    setBusy(true);
    try {
      await onAdd({ pubkey: parsed, role });
      toast.success(role === "admin" ? "Admin added" : "Member added");
      onOpenChange(false);
    } catch (error) {
      // The relay's refusal text names the rule that was broken.
      toast.error(
        error instanceof Error ? error.message : "Could not add that person.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-md" data-testid="add-member-dialog">
        <DialogHeader>
          <DialogTitle>Add someone to this community</DialogTitle>
          <DialogDescription>
            Paste their public key — an npub, an nprofile, or raw hex.
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Input
            aria-label="Public key"
            autoComplete="off"
            data-testid="add-member-input"
            disabled={busy}
            id={fieldId}
            onChange={(event) => setEntry(event.target.value)}
            placeholder="npub1…"
            spellCheck={false}
            value={entry}
          />

          {entry.trim().length > 0 && parsed === null ? (
            <p
              className="text-xs text-destructive"
              data-testid="add-member-invalid"
            >
              That is not a public key. An npub is 63 characters and starts with{" "}
              <code>npub1</code>.
            </p>
          ) : null}

          {parsed !== null ? (
            <div
              className="flex items-center gap-3 rounded-lg border border-border/60 bg-muted/30 px-3 py-2"
              data-testid="add-member-preview"
            >
              <ProfileAvatar
                className="size-8 text-2xs"
                label={resolvedName || truncatePubkey(parsed)}
                picture={profiles.get(parsed)?.avatar}
              />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">
                  {resolvedName || "No published profile"}
                </span>
                <span className="block truncate font-mono text-2xs text-muted-foreground">
                  {truncatePubkey(parsed)}
                </span>
              </span>
            </div>
          ) : null}

          {already ? (
            <p
              className="text-xs text-amber-600 dark:text-amber-400"
              data-testid="add-member-already"
            >
              Already a member. Adding again does nothing — the relay never
              overwrites an existing role. Use the row's menu to change it.
            </p>
          ) : null}

          {roles.length > 1 ? (
            <fieldset className="flex items-center gap-2">
              <legend className="sr-only">Role</legend>
              {roles.map((value) => (
                <Button
                  data-testid={`add-member-role-${value}`}
                  key={value}
                  onClick={() => setRole(value)}
                  size="sm"
                  type="button"
                  variant={role === value ? "secondary" : "ghost"}
                >
                  {ROLE_LABEL[value]}
                </Button>
              ))}
            </fieldset>
          ) : (
            <p className="text-xs text-muted-foreground">
              Admins may add members. Only the owner can grant the admin role.
            </p>
          )}

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
              data-testid="add-member-submit"
              disabled={!canAdd}
              size="sm"
              type="submit"
            >
              {busy ? "Adding…" : "Add"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
