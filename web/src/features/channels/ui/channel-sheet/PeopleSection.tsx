import type { ChannelMember, Profile } from "../../hooks.ts";
import { authorLabel } from "../../lib/authorLabel.ts";
import {
  isLastOwner,
  PEOPLE_ROLES,
  type PeopleRole,
} from "../../lib/channelMemberAdmin.ts";
import { AuthorAvatar } from "../AuthorAvatar";
import { MemberRowMenu } from "./MemberRowMenu";

export function PeopleSection({
  people,
  allMembers,
  profiles,
  selfPubkey,
  canManage,
  canModerate,
  busy,
  onRole,
  onRemove,
  onModerate,
}: {
  people: ChannelMember[];
  allMembers: ChannelMember[];
  profiles: Map<string, Profile>;
  selfPubkey: string | null;
  canManage: boolean;
  canModerate: (pubkey: string) => boolean;
  busy: boolean;
  onRole: (pubkey: string, role: PeopleRole) => void;
  onRemove: (member: ChannelMember) => void;
  onModerate: (member: ChannelMember, action: "timeout" | "ban") => void;
}) {
  return (
    <section aria-label="People" className="space-y-2">
      <h2 className="text-2xs uppercase tracking-wider text-muted-foreground">
        People · {people.length}
      </h2>
      <ul>
        {people.map((member) => {
          const label = authorLabel(member.pubkey, profiles);
          const lastOwner = isLastOwner(member, allMembers);
          const role = member.role ?? "member";
          return (
            <li
              key={member.pubkey}
              data-testid={`member-row-${member.pubkey}`}
              className="flex min-h-14 min-w-0 items-center gap-2 rounded-lg px-1 py-1 hover:bg-accent/50"
            >
              <AuthorAvatar
                pubkey={member.pubkey}
                label={label}
                picture={profiles.get(member.pubkey)?.avatar}
                size="md-sm"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium" title={label}>
                  {label}
                  {member.pubkey === selfPubkey && (
                    <span className="ml-1 text-xs font-normal text-muted-foreground">
                      (you)
                    </span>
                  )}
                </p>
                {!profiles.has(member.pubkey) && (
                  <p className="text-xs text-muted-foreground">No profile</p>
                )}
              </div>
              {canManage ? (
                <select
                  aria-label={`Role for ${label}`}
                  value={role}
                  disabled={busy || lastOwner}
                  title={lastOwner ? "A channel needs an owner" : undefined}
                  className="min-h-11 w-24 shrink-0 rounded-lg border border-border bg-card px-2 text-sm capitalize disabled:opacity-50"
                  onChange={(event) =>
                    onRole(member.pubkey, event.target.value as PeopleRole)
                  }
                >
                  {PEOPLE_ROLES.map((value) => (
                    <option key={value} value={value}>
                      {value[0].toUpperCase() + value.slice(1)}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="shrink-0 rounded-full bg-muted px-2 py-1 text-xs capitalize text-ink-2">
                  {role}
                </span>
              )}
              <MemberRowMenu
                label={label}
                busy={busy}
                canRemove={canManage}
                protectedOwner={lastOwner}
                canModerate={canModerate(member.pubkey)}
                onRemove={() => onRemove(member)}
                onModerate={(action) => onModerate(member, action)}
              />
            </li>
          );
        })}
      </ul>
      {people.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No people match your search.
        </p>
      )}
    </section>
  );
}
