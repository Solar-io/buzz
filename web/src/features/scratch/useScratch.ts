import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type {
  CommandResult,
  ScratchActions,
} from "@/features/commands/lib/commands.ts";
import {
  deleteChannelVerdict,
  LEAVE_CHANNEL_KIND,
  leaveChannelTags,
} from "@/features/channels/lib/channelAdmin.ts";
import type { ChannelSummary } from "@/features/channels/useChannels";
import { huddleMemberSnapshotFilter } from "@/features/huddle/lib/huddleMembers.ts";
import { publishWithRateLimitRetry } from "@/features/huddle/lib/huddlePublishRetry.ts";
import { queryOnce } from "@/features/pulse/lib/relayQuery.ts";
import {
  type ChannelMenuDeps,
  evictDeletedChannel,
} from "@/features/sidebar/lib/channelMenuItems.ts";
import type { RelaySession } from "@/shared/api/relay-session";
import {
  type SignedNostrEvent,
  signNostrEvent,
} from "@/shared/lib/nostr-signer";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { showToast, undoSpec } from "@/shared/ui/notify.ts";
import {
  buildScratchCreateEvent,
  buildScratchDeleteEvent,
  buildScratchKeepEvent,
  buildScratchMemberEvents,
  newestRoster,
  nextScratchName,
  SCRATCH_EXIT_UNDO_MS,
  scratchInfo,
  scratchLabel,
  scratchMemberPlan,
  viewerRole,
} from "./lib/scratchChannel.ts";

/** How long `/new` waits for the parent's roster before using what it has. */
const ROSTER_READ_TIMEOUT_MS = 6_000;

export interface UseScratchOptions {
  session: RelaySession;
  channels: readonly ChannelSummary[];
  selfPubkey: string | null;
  /**
   * The open channel's roster, as the route already holds it: the fallback
   * when the parent's own kind-39002 read comes back empty.
   */
  openRoster: { channelId: string | null; pubkeys: readonly string[] };
  /** Navigate to a conversation (?c=). */
  openChannel: (channelId: string) => void;
  /** Re-REQ the channel list — a new 39000 has no live fan-out. */
  refreshChannels: () => void;
  /** What a confirmed delete must evict, shared with "Delete channel". */
  evict: Pick<
    ChannelMenuDeps,
    "setChannelPrefs" | "setReadState" | "onChannelDeleted"
  >;
}

interface PendingExit {
  toastId: string | number;
  label: string;
  /**
   * The kind-9008, signed the moment /exit runs, so a commit on `pagehide`
   * reaches the socket synchronously instead of waiting on the signer while
   * the page is torn down.
   */
  signed: SignedNostrEvent | null;
  signing: Promise<SignedNostrEvent | Error>;
}

type Published = { ok: boolean; message: string };

/**
 * The scratch commands, run for real (web redesign Phase 3).
 *
 * Every publish is checked: `RelaySession.publish()` RESOLVES `{ok:false}`
 * on a refusal rather than throwing (AGENTS.md, web send-path traps), and a
 * rejection is folded into the same shape — so the relay's verdict is what
 * the user reads, verbatim, on every path.
 *
 * `/exit` is two-phase. The channel leaves the sidebar and the view at once
 * and an Undo toast opens; the kind-9008 goes out only when that TOAST runs
 * out (`onAutoClose`) or is dismissed. Sonner's timer is the only clock:
 * it pauses while the stack is hovered or the tab is hidden, and a second
 * clock kept here would delete underneath a paused Undo. Closing the page
 * inside the window commits early rather than stranding a channel the user
 * already threw away.
 */
export function useScratch(options: UseScratchOptions): {
  actions: ScratchActions;
  /** Scratch channels inside their Undo window: hidden from the sidebar. */
  exitingIds: ReadonlySet<string>;
  /** The viewer's role in a channel: the roster's, or owner of one made here. */
  roleIn: (
    channelId: string | null,
    members: readonly { pubkey: string; role?: string }[],
  ) => string | null;
} {
  const latest = useRef(options);
  latest.current = options;
  const pending = useRef(new Map<string, PendingExit>());
  /** Scratch channels this client created — their owner is the viewer. */
  const createdHere = useRef(new Set<string>());
  const [exitingIds, setExitingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const { actions, commit } = useMemo(() => {
    const failed = (error: unknown): Published => ({
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
    // Synchronous up to `socket.send` — the pagehide path depends on it.
    const send = async (signed: SignedNostrEvent): Promise<Published> => {
      try {
        return await publishWithRateLimitRetry(
          (event) => latest.current.session.publish(event),
          signed,
          { enabled: true },
        );
      } catch (error) {
        return failed(error);
      }
    };
    const publish = async (template: {
      kind: number;
      tags: string[][];
      content: string;
    }): Promise<Published> => {
      let signed: SignedNostrEvent;
      try {
        signed = await signNostrEvent(template);
      } catch (error) {
        return failed(error);
      }
      return send(signed);
    };
    const refreshSoon = () => {
      const { refreshChannels } = latest.current;
      refreshChannels();
      window.setTimeout(refreshChannels, 500);
      window.setTimeout(refreshChannels, 2000);
    };
    const labelOf = (channelId: string): string => {
      const channel = latest.current.channels.find(
        (candidate) => candidate.id === channelId,
      );
      const info = channel
        ? scratchInfo(channel, latest.current.channels)
        : null;
      return info
        ? `${info.label.parent} / ${info.label.rest}`
        : (channel?.name ?? "the scratch channel");
    };
    const setExiting = (channelId: string, on: boolean) =>
      setExitingIds((previous) => {
        if (previous.has(channelId) === on) {
          return previous;
        }
        const next = new Set(previous);
        if (on) {
          next.add(channelId);
        } else {
          next.delete(channelId);
        }
        return next;
      });

    const create: ScratchActions["create"] = async ({ parent, name }) => {
      const { channels, selfPubkey, openRoster, session } = latest.current;
      const named = nextScratchName(
        parent.name,
        channels.map((channel) => channel.name),
        name,
      );
      if ("error" in named) {
        return { ok: false, error: named.error };
      }
      const channelId = crypto.randomUUID();
      const built = buildScratchCreateEvent({
        channelId,
        name: named.name,
        parent,
      });
      if ("error" in built) {
        return { ok: false, error: built.error };
      }
      const created = await publish(built.event);
      if (!created.ok) {
        return {
          ok: false,
          error: created.message || "The relay refused the scratch channel.",
        };
      }
      createdHere.current.add(channelId);
      refreshSoon();

      // The parent's roster, read fresh: people AND agents, every role.
      const roster = newestRoster(
        await queryOnce(
          session,
          huddleMemberSnapshotFilter(parent.id),
          ROSTER_READ_TIMEOUT_MS,
        ),
        parent.id,
      );
      const source = roster
        ? [...roster.keys()]
        : openRoster.channelId === parent.id
          ? openRoster.pubkeys
          : [];
      const plan = scratchMemberPlan(source, selfPubkey);
      const failures: string[] = [];
      const adds = buildScratchMemberEvents(channelId, plan);
      for (const [index, event] of adds.entries()) {
        const added = await publish(event);
        if (!added.ok) {
          failures.push(
            `${truncatePubkey(plan[index])}: ${added.message || "refused"}`,
          );
        }
      }
      latest.current.openChannel(channelId);
      refreshSoon();
      const title = `${parent.name} / ${scratchLabel(named.name, parent.name).rest}`;
      if (failures.length > 0) {
        // The channel exists and is open; say exactly who is missing and
        // why, in the relay's own words.
        toast.error(
          `${failures.length} of ${plan.length} members could not be added to ${title}`,
          { description: failures.join("\n"), duration: 12_000 },
        );
      }
      const copied = plan.length - failures.length;
      return {
        ok: true,
        notice:
          plan.length === 0
            ? `Opened ${title} — nobody else to copy from #${parent.name}`
            : `Opened ${title} with ${copied} ${copied === 1 ? "member" : "members"} from #${parent.name}`,
      };
    };

    const commit = async (channelId: string): Promise<void> => {
      const entry = pending.current.get(channelId);
      if (!entry) {
        return;
      }
      // Out of the map FIRST: the dismiss below fires `onDismiss`, which
      // calls back in here and must find nothing left to commit.
      pending.current.delete(channelId);
      toast.dismiss(entry.toastId);
      const signed = entry.signed ?? (await entry.signing);
      const result =
        signed instanceof Error ? failed(signed) : await send(signed);
      const verdict = deleteChannelVerdict(channelId, result);
      if (verdict.outcome === "deleted") {
        evictDeletedChannel(channelId, latest.current.evict);
        refreshSoon();
      } else {
        toast.error(`Could not delete ${entry.label}`, {
          description:
            verdict.message ||
            "The relay refused the delete (owners only). It stays in Scratch.",
        });
      }
      setExiting(channelId, false);
    };

    const exit: ScratchActions["exit"] = async ({ channelId, parent }) => {
      if (pending.current.has(channelId)) {
        return { ok: true };
      }
      const label = labelOf(channelId);
      setExiting(channelId, true);
      latest.current.openChannel(parent.id);
      const undo = () => {
        if (!pending.current.delete(channelId)) {
          return;
        }
        setExiting(channelId, false);
        latest.current.openChannel(channelId);
      };
      const entry: PendingExit = {
        toastId: "",
        label,
        signed: null,
        signing: signNostrEvent(buildScratchDeleteEvent(channelId)).then(
          (event) => {
            entry.signed = event;
            return event;
          },
          (error: unknown) =>
            error instanceof Error ? error : new Error(String(error)),
        ),
      };
      pending.current.set(channelId, entry);
      entry.toastId = showToast(
        undoSpec({
          lead: `Left ${label}`,
          meta: `deleted in ${SCRATCH_EXIT_UNDO_MS / 1000} s · back in #${parent.name}`,
          windowMs: SCRATCH_EXIT_UNDO_MS,
          onUndo: undo,
        }),
        `scratch-exit:${channelId}`,
        {
          // The toast's own end is the commit: its timer pauses on hover and
          // in a hidden tab, and so does the delete. Undo removes the entry
          // before sonner dismisses, so that dismiss commits nothing.
          onAutoClose: () => void commit(channelId),
          onDismiss: () => void commit(channelId),
        },
      );
      return { ok: true };
    };

    const leave: ScratchActions["leave"] = async ({ channelId, parent }) => {
      const label = labelOf(channelId);
      const left = await publish({
        kind: LEAVE_CHANNEL_KIND,
        tags: leaveChannelTags(channelId),
        content: "",
      });
      if (!left.ok) {
        return {
          ok: false,
          error: left.message || "The relay refused the leave.",
        };
      }
      // Private: without membership the room is gone for this viewer.
      evictDeletedChannel(channelId, latest.current.evict);
      latest.current.openChannel(parent.id);
      refreshSoon();
      return { ok: true, notice: `Left ${label} — its owner can add you back` };
    };

    const keep: ScratchActions["keep"] = async ({
      channelId,
      name,
    }): Promise<CommandResult> => {
      const built = buildScratchKeepEvent(channelId, name);
      if ("error" in built) {
        return { ok: false, error: built.error };
      }
      const label = labelOf(channelId);
      const kept = await publish(built.event);
      if (!kept.ok) {
        return {
          ok: false,
          error: kept.message || "The relay refused /keep.",
        };
      }
      refreshSoon();
      const renamed = built.event.tags.find((tag) => tag[0] === "name")?.[1];
      return {
        ok: true,
        notice: renamed
          ? `Kept as #${renamed} — a permanent channel now`
          : `Kept ${label} — a permanent channel now`,
      };
    };

    return { actions: { create, exit, keep, leave }, commit };
  }, []);

  const roleIn = useCallback(
    (
      channelId: string | null,
      members: readonly { pubkey: string; role?: string }[],
    ) =>
      channelId === null
        ? null
        : viewerRole(
            members,
            latest.current.selfPubkey,
            createdHere.current.has(channelId),
          ),
    [],
  );

  // Leaving the page (or this shell) inside an Undo window commits it: the
  // user already threw the channel away, and nothing else would delete it.
  useEffect(() => {
    const flush = () => {
      for (const channelId of [...pending.current.keys()]) {
        void commit(channelId);
      }
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [commit]);

  return { actions, exitingIds, roleIn };
}
