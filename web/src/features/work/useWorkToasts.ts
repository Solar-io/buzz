import { useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";

import { useObserverStore } from "@/features/agents/ObserverProvider";
import { useProfiles } from "@/features/channels/hooks";
import { authorLabel } from "@/features/channels/lib/authorLabel.ts";
import { useAsks } from "@/features/home/AsksProvider";
import { useWorkflowActions } from "@/features/workflows/useWorkflowActions";
import { notify } from "@/shared/ui/notify";
import { useWorkContext } from "./workContext.ts";
import { frameTriggers } from "./lib/activeTurns.ts";
import { shouldToastNeed } from "./lib/needsToast.ts";
import { includesOwnSend } from "./lib/ownSends.ts";
import { useNowSeconds, useWorkFeed } from "./useWorkFeed.ts";
import { channelLabel, metaLine } from "./ui/workLabels.ts";

/** Rows that arrive in the first moments are history, not news. */
const SETTLE_MS = 10_000;

/**
 * The Work tab's two toasts (phase-1 §5):
 *
 * - needs-you: an approval or ask that ARRIVED after the feed settled, while
 *   no Work surface is on screen, outside the conversation I am reading
 *   (`lib/needsToast.ts`). Sticky; it leaves when the row does.
 * - agent-done: a `turn_completed` for a turn one of MY messages started
 *   (its `turn_started` triggers ∩ this browser's sends), in a channel I am
 *   not looking at. Deliberately narrow — every agent's every turn would
 *   flood a 20-agent fleet.
 *
 * Renders nothing. Mounted once in ShellProviders.
 */
export function WorkToasts({
  selectedId,
  onOpenMessage,
  onOpenChannel,
  onOpenView,
}: {
  selectedId: string | null;
  onOpenMessage: (channelId: string, messageId: string) => void;
  onOpenChannel: (channelId: string) => void;
  onOpenView: (view: "workflows" | "reminders") => void;
}): null {
  const context = useWorkContext();
  const { loading } = useAsks();
  const nowS = useNowSeconds(30_000);
  const feed = useWorkFeed({ scope: "everywhere", channelId: null, nowS });
  const observer = useObserverStore();
  const { decideApproval } = useWorkflowActions();
  const mountedAt = useRef(Date.now());
  const seen = useRef(new Set<string>());
  const toasted = useRef(new Set<string>());
  const doneTurns = useRef(new Set<string>());

  const actorKeys = useMemo(
    () => [
      ...new Set([
        ...feed.needs.flatMap((row) =>
          row.actorPubkey ? [row.actorPubkey] : [],
        ),
        ...(observer ? [...observer.byAgent.keys()] : []),
      ]),
    ],
    [feed.needs, observer],
  );
  const profiles = useProfiles(actorKeys);
  const latest = useRef({
    profiles,
    context,
    selectedId,
    onOpenMessage,
    onOpenChannel,
    onOpenView,
    decideApproval,
  });
  latest.current = {
    profiles,
    context,
    selectedId,
    onOpenMessage,
    onOpenChannel,
    onOpenView,
    decideApproval,
  };

  // ---- needs-you -------------------------------------------------------------
  useEffect(() => {
    const settled = !loading && Date.now() - mountedAt.current > SETTLE_MS;
    const keys = new Set(feed.needs.map((row) => row.key));
    for (const key of toasted.current) {
      if (!keys.has(key)) {
        toast.dismiss(`needs:${key}`);
        toasted.current.delete(key);
      }
    }
    for (const row of feed.needs) {
      if (seen.current.has(row.key)) {
        continue;
      }
      seen.current.add(row.key);
      const current = latest.current;
      if (
        !shouldToastNeed(row, {
          settled,
          workVisible: current.context?.workVisible() ?? false,
          selectedId: current.selectedId,
        })
      ) {
        continue;
      }
      const where = channelLabel(row.channelId, current.context?.channels);
      toasted.current.add(row.key);
      if (row.source.kind === "approval") {
        const ref = row.source.approval.ref;
        notify.needsYou(
          {
            // Toasts artboard: "<who> needs your approval". An approval is
            // relay-authored (no actor to name), so the workflow is the who.
            lead: "Workflow",
            rest: "needs your approval",
            meta: metaLine(row.title, where),
            seed: null,
            agent: false,
            primary: {
              label: "Approve",
              onClick: () => {
                void current
                  .decideApproval(ref, true)
                  .catch((error: unknown) => {
                    notify.sendError({
                      message:
                        error instanceof Error ? error.message : String(error),
                      onRetry: () => void current.decideApproval(ref, true),
                      onCopy: () =>
                        void navigator.clipboard?.writeText(String(error)),
                    });
                  });
              },
            },
            secondary: {
              label: "Review",
              onClick: () => current.onOpenView("workflows"),
            },
          },
          `needs:${row.key}`,
        );
      } else if (row.open && "channelId" in row.open) {
        const open = row.open;
        notify.needsYou(
          {
            lead: row.actorPubkey
              ? authorLabel(row.actorPubkey, current.profiles)
              : "Someone",
            rest: "asks",
            meta: metaLine(row.title, where),
            seed: row.actorPubkey,
            agent: true,
            primary: {
              label: "Review",
              onClick: () =>
                current.onOpenMessage(open.channelId, open.messageId),
            },
          },
          `needs:${row.key}`,
        );
      }
    }
  }, [feed.needs, loading]);

  // ---- agent-done --------------------------------------------------------------
  const byAgent = observer?.byAgent;
  useEffect(() => {
    if (!byAgent) {
      return;
    }
    const since = Math.floor(mountedAt.current / 1000);
    for (const [agent, frames] of byAgent) {
      for (const frame of frames) {
        if (
          frame.kind !== "turn_completed" ||
          !frame.turnId ||
          frame.createdAt < since
        ) {
          continue;
        }
        const key = `${agent}:${frame.turnId}`;
        if (doneTurns.current.has(key)) {
          continue;
        }
        doneTurns.current.add(key);
        const started = frames.find(
          (candidate) =>
            candidate.kind === "turn_started" &&
            candidate.turnId === frame.turnId,
        );
        if (!started || !includesOwnSend(frameTriggers(started))) {
          continue;
        }
        const channelId = frame.channelId ?? started.channelId;
        const current = latest.current;
        if (channelId && channelId === current.selectedId) {
          continue;
        }
        const payload = frame.payload as { stopReason?: unknown } | null;
        notify.agentDone({
          agent: authorLabel(agent, current.profiles),
          meta: metaLine(
            channelLabel(channelId, current.context?.channels),
            typeof payload?.stopReason === "string" ? payload.stopReason : null,
          ),
          onOpen: () => channelId && current.onOpenChannel(channelId),
        });
      }
    }
  }, [byAgent]);

  return null;
}
