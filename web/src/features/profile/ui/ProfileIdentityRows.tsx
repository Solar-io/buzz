import {
  BadgeCheck,
  Pencil,
  ShieldAlert,
  UserMinus,
  UserPlus,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { useCommunityRoster } from "@/features/community-members/hooks";
import { roleOf } from "@/features/community-members/lib/members";
import { RoleBadge } from "@/features/community-members/ui/RoleBadge";
import { PresenceBadge } from "@/features/presence/ui/PresenceBadge";
import { usePresenceStatus } from "@/features/presence/hooks";
import { useUserStatuses } from "@/features/user-status/hooks";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";

import { nip05Label, nip05Tone, type Nip05Status } from "../lib/nip05.ts";
import { isRenamed } from "../lib/userLabels.ts";
import { useNip05Status } from "../useNip05.ts";
import { useUserLabels } from "../useUserLabels.ts";

/**
 * The NIP-05 handle, with the domain's verdict attached.
 *
 * The bare handle is *not* rendered on its own anywhere any more: a `nip05`
 * field is a self-published claim, and printing "sam@block.xyz" unqualified is
 * how a stranger gets read as a colleague. Verified is a tick, disagreement is
 * a warning, and everything else is shown plainly as unproven.
 */
export function Nip05Row({
  claim,
  pubkey,
  className,
}: {
  claim: string;
  pubkey: string;
  className?: string;
}) {
  const status = useNip05Status(claim, pubkey);
  const trimmed = claim.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const tone = nip05Tone(status);
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1 text-2xs",
        tone === "good" && "text-emerald-600 dark:text-emerald-400",
        tone === "bad" && "text-destructive",
        tone === "neutral" && "text-muted-foreground",
        className,
      )}
      data-nip05={status}
      data-testid="profile-nip05"
      title={nip05Label(status) || undefined}
    >
      <span className="truncate">{trimmed}</span>
      {status === "verified" ? (
        <BadgeCheck
          aria-label="Verified by the domain"
          className="size-3 shrink-0"
        />
      ) : null}
      {status === "mismatch" ? (
        <ShieldAlert
          aria-label="The domain does not confirm this name"
          className="size-3 shrink-0"
        />
      ) : null}
    </span>
  );
}

/** The subject's role in this community, when the relay publishes a roster. */
export function CommunityRoleRow({ pubkey }: { pubkey: string }) {
  const roster = useCommunityRoster();
  const role = roleOf(roster, pubkey);
  if (role === null) {
    return null;
  }
  return <RoleBadge role={role} />;
}

/** Presence plus whatever the person set as their own status text. */
export function PresenceStatusRow({ pubkey }: { pubkey: string }) {
  const presence = usePresenceStatus(pubkey);
  const statuses = useUserStatuses([pubkey]);
  const status = statuses.get(pubkey);
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-2">
      <PresenceBadge status={presence} />
      {status ? (
        <span
          className="min-w-0 truncate text-xs text-muted-foreground"
          data-testid="profile-user-status"
        >
          {status.emoji ? `${status.emoji} ` : ""}
          {status.text}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Follow / unfollow.
 *
 * Disabled until the viewer's contact list has actually been read — see
 * `buildContactListEvent`, which refuses to publish before then because an
 * unread list and an empty one are indistinguishable, and guessing wrong
 * replaces every follow the user has.
 */
export function FollowButton({
  following,
  ready,
  pending,
  onToggle,
  className,
}: {
  following: boolean;
  ready: boolean;
  pending: boolean;
  onToggle: () => Promise<void>;
  className?: string;
}) {
  return (
    <Button
      className={className}
      data-testid="profile-follow"
      disabled={!ready || pending}
      onClick={() => {
        void onToggle().catch((error: unknown) =>
          toast.error(
            error instanceof Error
              ? error.message
              : "Could not update follows.",
          ),
        );
      }}
      size="sm"
      title={ready ? undefined : "Waiting for your follow list to load"}
      type="button"
      variant={following ? "secondary" : "outline"}
    >
      {following ? <UserMinus aria-hidden /> : <UserPlus aria-hidden />}
      {following ? "Unfollow" : "Follow"}
    </Button>
  );
}

/**
 * Rename somebody, for this browser only.
 *
 * The published name stays visible underneath while a nickname is in force, so
 * a local label can never be mistaken for what the person actually calls
 * themselves — which is the property that keeps this from being an
 * impersonation vector rather than a convenience.
 */
export function RenameRow({
  pubkey,
  publishedName,
}: {
  pubkey: string;
  publishedName: string;
}) {
  const { labels, rename } = useUserLabels();
  const current = labels[pubkey.toLowerCase()] ?? "";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(current);

  useEffect(() => {
    setDraft(current);
  }, [current]);

  if (!editing) {
    return (
      <div className="flex min-w-0 items-center gap-2">
        <Button
          className="px-1"
          data-testid="profile-rename-open"
          onClick={() => setEditing(true)}
          size="xs"
          type="button"
          variant="ghost"
        >
          <Pencil aria-hidden />
          {current ? "Rename" : "Add a nickname"}
        </Button>
        {isRenamed(labels, pubkey, publishedName) ? (
          <span
            className="min-w-0 truncate text-2xs text-muted-foreground"
            data-testid="profile-published-name"
          >
            publishes as “{publishedName}”
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        rename(pubkey, draft);
        setEditing(false);
      }}
    >
      <Input
        aria-label="Nickname for this person, on this device only"
        className="h-7"
        data-testid="profile-rename-input"
        onChange={(event) => setDraft(event.target.value)}
        placeholder={publishedName}
        value={draft}
      />
      <Button data-testid="profile-rename-save" size="xs" type="submit">
        Save
      </Button>
      <Button
        onClick={() => {
          setDraft(current);
          setEditing(false);
        }}
        size="xs"
        type="button"
        variant="ghost"
      >
        Cancel
      </Button>
    </form>
  );
}

export type { Nip05Status };
