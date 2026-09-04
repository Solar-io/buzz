import { Ban, CircleSlash, ShieldCheck, Trash2, UserMinus } from "lucide-react";
import { useCallback } from "react";
import { toast } from "sonner";

import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/shared/ui/dropdown-menu";
import {
  useCommunityRestrictions,
  useModerationActions,
  useModerationCapability,
} from "../hooks.ts";
import { findRestriction, isTimedOut } from "../lib/restrictions.ts";
import { TimeoutDurationSubmenu } from "./TimeoutDurationSubmenu.tsx";

/**
 * The moderation actions the viewer may take against one message's author,
 * rendered inside the message overflow menu.
 *
 * Self-wiring (capability, restriction state and the publish actions are all
 * resolved here) so the action bar only threads the three ids it already has.
 * Renders **nothing** unless the relay would actually accept at least one of
 * the commands — the gate is `useModerationCapability`, which mirrors the two
 * distinct authorities the relay enforces (channel role for remove/kick,
 * community role for ban/timeout). See `lib/capability.ts` for the mapping and
 * the file:line evidence behind it.
 */
export function MessageModerationMenuItems({
  messageId,
  channelId,
  authorPubkey,
}: {
  messageId: string;
  /** Channel the message lives in — required for remove and kick. */
  channelId?: string | null;
  /** The message author; every action targets this key. */
  authorPubkey?: string | null;
}) {
  const capability = useModerationCapability({ channelId, authorPubkey });
  const canRestrict = capability.canBan || capability.canTimeout;
  const restrictions = useCommunityRestrictions(canRestrict);
  const actions = useModerationActions();

  const restriction = findRestriction(restrictions, authorPubkey);
  const isBanned = restriction?.banned ?? false;
  const timedOut = isTimedOut(restriction?.mutedUntil);

  const run = useCallback(
    async (action: () => Promise<unknown>, success: string) => {
      try {
        await action();
        toast.success(success);
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Moderation action failed",
        );
      }
    },
    [],
  );

  // Every branch below needs the author key; bail before rendering a separator
  // that would sit above nothing.
  if (!authorPubkey) {
    return null;
  }
  const canRemove = capability.canRemoveMessage && Boolean(channelId);
  const canKick = capability.canKick && Boolean(channelId);
  if (!canRemove && !canKick && !canRestrict) {
    return null;
  }

  return (
    <>
      <DropdownMenuSeparator />

      {canRemove && channelId ? (
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          data-testid={`moderate-remove-${messageId}`}
          onClick={() =>
            void run(
              () =>
                actions.removeMessage({
                  channelId,
                  targetEventId: messageId,
                  publicReason: "Removed by a moderator",
                }),
              "Message removed",
            )
          }
        >
          <Trash2 className="h-4 w-4" aria-hidden="true" />
          Remove message
        </DropdownMenuItem>
      ) : null}

      {capability.canTimeout &&
        (timedOut ? (
          <DropdownMenuItem
            data-testid={`moderate-untimeout-${messageId}`}
            onClick={() =>
              void run(
                () => actions.untimeoutAuthor(authorPubkey),
                "Timeout lifted",
              )
            }
          >
            <ShieldCheck className="h-4 w-4" aria-hidden="true" />
            Lift timeout
          </DropdownMenuItem>
        ) : (
          <TimeoutDurationSubmenu
            testIdPrefix={`moderate-timeout-${messageId}`}
            onSelect={(expiresAt) =>
              void run(
                () =>
                  actions.timeoutAuthor({ pubkey: authorPubkey, expiresAt }),
                "Author timed out",
              )
            }
          />
        ))}

      {canKick && channelId ? (
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          data-testid={`moderate-kick-${messageId}`}
          onClick={() =>
            void run(
              () => actions.kickAuthor({ channelId, pubkey: authorPubkey }),
              "Author removed from channel",
            )
          }
        >
          <UserMinus className="h-4 w-4" aria-hidden="true" />
          Kick from channel
        </DropdownMenuItem>
      ) : null}

      {capability.canBan &&
        (isBanned ? (
          <DropdownMenuItem
            data-testid={`moderate-unban-${messageId}`}
            onClick={() =>
              void run(() => actions.unbanAuthor(authorPubkey), "Ban lifted")
            }
          >
            <CircleSlash className="h-4 w-4" aria-hidden="true" />
            Lift ban
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            data-testid={`moderate-ban-${messageId}`}
            onClick={() =>
              void run(() => actions.banAuthor(authorPubkey), "Author banned")
            }
          >
            <Ban className="h-4 w-4" aria-hidden="true" />
            Ban author from community
          </DropdownMenuItem>
        ))}
    </>
  );
}
