import { Users } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import type { ChannelMember, Profile } from "../hooks.ts";
import type { PresenceEntry } from "../lib/presence.ts";
import { presenceDotClass } from "../lib/presence.ts";
import { authorLabel } from "../lib/authorLabel.ts";
import { AuthorAvatar } from "./AuthorAvatar.tsx";

/**
 * Member count + roster, the desktop's `ChannelMembersBar` "Users N" control.
 *
 * The count is the header's only quantitative signal about a channel, and
 * the roster behind it is how you find out whether the person you are
 * waiting on is even in the room. Presence dots reuse the sidebar's palette
 * so "online" means the same colour everywhere.
 */
export function ChannelMembersButton({
  members,
  profiles,
  presence,
}: {
  members: ChannelMember[];
  profiles: Map<string, Profile>;
  /** pubkey → presence, when the shell is tracking it. */
  presence?: Map<string, PresenceEntry>;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="channel-members-trigger"
          aria-label={`View channel members (${members.length})`}
          title="Channel members"
          className="flex shrink-0 items-center gap-1 rounded-full border border-border px-2 py-1 text-2xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Users aria-hidden className="h-4 w-4" />
          <span className="min-w-[1ch] tabular-nums">{members.length}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="max-h-80 w-64 overflow-y-auto p-1">
        {members.length === 0 ? (
          <p className="p-3 text-xs text-muted-foreground">
            No members loaded yet.
          </p>
        ) : (
          <ul className="flex flex-col">
            {members.map((member) => {
              const status = presence?.get(member.pubkey)?.status ?? "unknown";
              return (
                <li
                  key={member.pubkey}
                  data-testid="channel-member-row"
                  className="flex items-center gap-2 rounded-md px-2 py-1.5"
                >
                  <span className="relative shrink-0">
                    <AuthorAvatar
                      pubkey={member.pubkey}
                      label={authorLabel(member.pubkey, profiles)}
                      picture={profiles.get(member.pubkey)?.avatar}
                      size="sm"
                    />
                    <span
                      aria-hidden
                      className={`absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ring-2 ring-popover ${presenceDotClass(status)}`}
                    />
                  </span>
                  <span className="truncate text-xs">
                    {authorLabel(member.pubkey, profiles)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
