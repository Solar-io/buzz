import { useMemo, useRef } from "react";
import { toast } from "sonner";

import type { CommandResult } from "@/features/commands/lib/commands.ts";
import type { ItemCommandActions } from "@/features/commands/lib/itemCommands.ts";
import { deleteChannelMessage } from "@/features/channels/hooks";
import type { ChannelSummary } from "@/features/channels/useChannels";
import { scratchInfo } from "@/features/scratch/lib/scratchChannel.ts";
import { channelLabel } from "@/features/work/ui/workLabels.ts";
import { useWorkContext } from "@/features/work/workContext.ts";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import {
  type SignedNostrEvent,
  signNostrEvent,
} from "@/shared/lib/nostr-signer";
import { useOwnPubkey } from "@/shared/lib/useOwnPubkey";
import { showToast, undoSpec } from "@/shared/ui/notify.ts";
import { useItems } from "./ItemsProvider";
import {
  editDraft,
  type ItemHead,
  type ItemPatch,
  type ItemType,
  itemTemplate,
  newItemId,
  nextCreatedAt,
  shortItemId,
} from "./lib/itemEvent.ts";
import { fileItem } from "./lib/fileItem.ts";
import {
  handoffTemplate,
  type MessageTemplate,
  scratchKickoffTemplate,
} from "./lib/itemMessages.ts";
import { inferProject } from "./lib/itemsView.ts";

/** How long a filed item can be taken back. */
export const FILE_UNDO_MS = 8_000;

export type Published = { ok: boolean; message: string };

type Template = MessageTemplate & { created_at?: number };

/**
 * Everything the Items page and the `/bug` · `/backlog` commands publish.
 *
 * Every publish is CHECKED: `RelaySession.publish()` resolves `{ok:false}`
 * on a refusal rather than throwing (AGENTS.md, web send-path traps), and a
 * throw (signing, a closed session) is folded into the same shape — so the
 * relay's verdict is what the user reads, verbatim, on every path. A head
 * that was accepted is applied to the fold at once instead of waiting for
 * the relay's echo.
 */
export function useItemActions() {
  const items = useItems();
  const { session } = useRelaySession();
  const channels = useWorkContext()?.channels;
  const selfPubkey = useOwnPubkey();
  const latest = useRef({ items, session, channels, selfPubkey });
  latest.current = { items, session, channels, selfPubkey };

  return useMemo(() => {
    const publish = async (
      template: Template,
    ): Promise<Published & { event: SignedNostrEvent | null }> => {
      try {
        const event = await signNostrEvent(template);
        const result = await latest.current.session.publish(event);
        return { ...result, event };
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
          event: null,
        };
      }
    };
    const nowS = () => Math.floor(Date.now() / 1000);
    const allChannels = (): readonly ChannelSummary[] =>
      latest.current.channels ?? [];

    /** This channel and, for a scratch channel, the one it was copied from. */
    const lineage = (channelId: string): string[] => {
      const channel = allChannels().find((c) => c.id === channelId);
      const info = channel ? scratchInfo(channel, allChannels()) : null;
      return info ? [channelId, info.parentId] : [channelId];
    };

    const projectFor = (channelId: string) =>
      inferProject(latest.current.items?.latest() ?? [], lineage(channelId));

    /** Publish the next head of `item` with `patch` applied. */
    const update = async (
      item: ItemHead,
      patch: ItemPatch,
    ): Promise<Published> => {
      const now = nowS();
      const built = itemTemplate(
        editDraft(item, patch),
        nextCreatedAt(item.updatedAt, now),
        now,
      );
      if (!built.ok) {
        return { ok: false, message: `item: ${built.error}` };
      }
      const result = await publish(built.template);
      if (result.ok && result.event) {
        latest.current.items?.ingest(result.event);
      }
      return { ok: result.ok, message: result.message };
    };

    /** The same patch over many items; the refusals, in the relay's words. */
    const updateEach = async (
      list: readonly ItemHead[],
      patchOf: (item: ItemHead) => ItemPatch | null,
    ): Promise<{ changed: number; failures: string[] }> => {
      let changed = 0;
      const failures: string[] = [];
      for (const item of list) {
        const patch = patchOf(item);
        if (patch === null) {
          continue;
        }
        const result = await update(item, patch);
        if (result.ok) {
          changed += 1;
        } else {
          failures.push(
            `${shortItemId(item.id)}: ${result.message || "refused"}`,
          );
        }
      }
      return { changed, failures };
    };

    /** A new item from the Items page (no conversation, so no source row). */
    const create = async (input: {
      type: ItemType;
      title: string;
      summary: string | null;
      body: string;
      channelId: string | null;
      projectName: string | null;
    }): Promise<Published> => {
      const self = latest.current.selfPubkey;
      if (!self) {
        return { ok: false, message: "Sign in to file items." };
      }
      const now = nowS();
      const built = itemTemplate(
        {
          d: newItemId(),
          channelId: input.channelId,
          type: input.type,
          status: "open",
          title: input.title,
          summary: input.summary,
          body: input.body,
          created: now,
          reporter: self,
          owner: null,
          sourceEventId: null,
          projectCoordinate: null,
          projectName: input.projectName,
        },
        now,
        now,
      );
      if (!built.ok) {
        return { ok: false, message: `item: ${built.error}` };
      }
      const result = await publish(built.template);
      if (result.ok && result.event) {
        latest.current.items?.ingest(result.event);
      }
      return { ok: result.ok, message: result.message };
    };

    /**
     * `/bug` and `/backlog` (`lib/fileItem.ts` holds the publish order), then
     * the Undo toast: within its window the head and the row are deleted
     * (kind 5, per author — D5.10), and the item leaves the fold at once.
     */
    const file: ItemCommandActions["file"] = async ({
      type,
      title,
      channelId,
    }): Promise<CommandResult> => {
      const self = latest.current.selfPubkey;
      if (!self) {
        return { ok: false, error: "Sign in to file items." };
      }
      const project = projectFor(channelId);
      const outcome = await fileItem<SignedNostrEvent>(
        {
          sign: (template) => signNostrEvent(template),
          publish: (event) => latest.current.session.publish(event),
          newId: () => newItemId(),
          nowS: nowS(),
        },
        { type, title, channelId, reporter: self, project },
      );
      if (!outcome.ok) {
        return { ok: false, error: outcome.error };
      }
      const { d, head, row, rowRefused } = outcome;
      latest.current.items?.ingest(head);
      const rowPosted = rowRefused === null;
      if (!rowPosted) {
        toast.error("Filed — but the confirmation row was refused", {
          description: rowRefused,
        });
      }
      const undo = async () => {
        const { session } = latest.current;
        const removed = await deleteChannelMessage(session, {
          channelId,
          targetEventId: head.id,
        }).catch((error: unknown) => ({
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        }));
        if (!removed.ok) {
          toast.error("Could not take the item back", {
            description: removed.message,
          });
          return;
        }
        latest.current.items?.forget([head.id]);
        if (rowPosted) {
          await deleteChannelMessage(session, {
            channelId,
            targetEventId: row.id,
          }).catch(() => undefined);
        }
      };
      showToast({
        ...undoSpec({
          lead: type === "bug" ? "Filed a bug" : "Added to backlog",
          rest: `· ${title}`,
          meta: [
            `item ${shortItemId(d)}`,
            project?.label,
            channelLabel(channelId, allChannels()),
          ]
            .filter(Boolean)
            .join(" · "),
          windowMs: FILE_UNDO_MS,
          onUndo: () => void undo(),
        }),
        icon: { kind: "done" },
      });
      return { ok: true };
    };

    /**
     * "Hand to an agent…": one handoff per source channel, naming every
     * picked item there, then each item's owner set to the seat. The seat
     * must be a member of each channel — the picker only offers such seats.
     */
    const handOff = async (input: {
      items: readonly ItemHead[];
      seat: { pubkey: string; name: string };
      note: string;
    }): Promise<{ failures: string[] }> => {
      const failures: string[] = [];
      const byChannel = new Map<string, ItemHead[]>();
      for (const item of input.items) {
        if (item.channelId === null) {
          failures.push(`${shortItemId(item.id)}: it has no source channel`);
          continue;
        }
        const list = byChannel.get(item.channelId) ?? [];
        list.push(item);
        byChannel.set(item.channelId, list);
      }
      for (const [channelId, list] of byChannel) {
        const sent = await publish(
          handoffTemplate({
            channelId,
            seat: input.seat,
            items: list,
            note: input.note,
          }),
        );
        if (!sent.ok) {
          failures.push(
            `${channelLabel(channelId, allChannels()) || "channel"}: ${sent.message || "refused"}`,
          );
          continue;
        }
        const owned = await updateEach(list, (item) =>
          item.owner === input.seat.pubkey
            ? null
            : { owner: input.seat.pubkey },
        );
        failures.push(...owned.failures);
      }
      return { failures };
    };

    /** The first message of a scratch channel opened for `item`. */
    const kickoff = (channelId: string, item: ItemHead) =>
      publish(scratchKickoffTemplate({ channelId, item }));

    const commandActions: ItemCommandActions = {
      file,
      projectFor: (channelId) => projectFor(channelId)?.label ?? null,
    };

    return {
      update,
      updateEach,
      create,
      file,
      handOff,
      kickoff,
      commandActions,
    };
  }, []);
}
