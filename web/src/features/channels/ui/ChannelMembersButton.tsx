import { useState } from "react";
import { Plus, Users } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import type { ChannelMember, Profile } from "../hooks.ts";
import type { PresenceEntry } from "../lib/presence.ts";
import { presenceDotClass } from "../lib/presence.ts";
import { authorLabel } from "../lib/authorLabel.ts";
import { AuthorAvatar } from "./AuthorAvatar.tsx";
import { AddChannelMembersDialog } from "./AddChannelMembersDialog.tsx";

/**
 * Member count + roster, the desktop's `ChannelMembersBar` "Users N" control.
 *
 * The count is the header's only quantitative signal about a channel, and
 * the roster behind it is how you find out whether the person you are
 * waiting on is even in the room. Presence dots reuse the sidebar's palette
 * so "online" means the same colour everywhere.
 *
 * The "+ Add" affordance is rendered for EVERYONE — rights are the relay's
 * call, not the client's (a member without rights publishes, is refused, and
 * the refusal shows as a toast). That mirrors the huddle add-agent flow; the
 * desktop hides its control behind `canManageMembers`, but the web client has
 * no reliable role signal for NIP-29 channels, and a hidden control would
 * make an admin who IS allowed see no way to add at all.
 */
export function ChannelMembersButton({
  channelId,
  members,
  profiles,
  presence,
  contacts = [],
  selfPubkey = null,
}: {
  /** The channel the roster belongs to (kind-9000 `h` tag for the add). */
  channelId: string;
  members: ChannelMember[];
  profiles: Map<string, Profile>;
  /** pubkey → presence, when the shell is tracking it. */
  presence?: Map<string, PresenceEntry>;
  /** DM counterparty pubkeys, for the add dialog's suggestions. */
  contacts?: string[];
  /** The viewer — excluded from add suggestions. */
  selfPubkey?: string | null;
}) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  return (
    <>
      <Popover onOpenChange={setPopoverOpen} open={popoverOpen}>
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
        <PopoverContent
          align="end"
          className="max-h-80 w-64 overflow-y-auto p-1"
        >
          <div className="flex items-center justify-between px-2 py-1.5">
            <span className="text-2xs uppercase tracking-wide text-muted-foreground">
              Members
            </span>
            <button
              type="button"
              data-testid="channel-members-add"
              className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-2xs text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => {
                // Close the popover so the dialog owns the next click, and
                // reopening the roster after the add shows the new member.
                setPopoverOpen(false);
                setAddOpen(true);
              }}
            >
              <Plus aria-hidden className="h-3 w-3" />
              Add
            </button>
          </div>
          {members.length === 0 ? (
            <p className="p-3 text-xs text-muted-foreground">
              No members loaded yet.
            </p>
          ) : (
            <ul className="flex flex-col">
              {members.map((member) => {
                const status =
                  presence?.get(member.pubkey)?.status ?? "unknown";
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
      <AddChannelMembersDialog
        channelId={channelId}
        contacts={contacts}
        memberPubkeys={members.map((member) => member.pubkey)}
        onOpenChange={setAddOpen}
        open={addOpen}
        selfPubkey={selfPubkey}
      />
    </>
  );
}
