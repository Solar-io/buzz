import { useMemo, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { toast } from "sonner";

import { useProfiles } from "@/features/channels/hooks";
import { useChannels } from "@/features/channels/useChannels";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import { buildModerationQueue, openReports } from "../lib/queue.ts";
import type { ModerationQueueGroup } from "../lib/queue.ts";
import { queueAuthority } from "../lib/queueAuthority.ts";
import type { ResolutionAction } from "../lib/queueAuthority.ts";
import {
  useModerationAudit,
  useModerationReports,
  useReportedEvents,
  useResolveReport,
  useViewerChannelRoles,
  useViewerCommunityRole,
} from "../queueHooks.ts";
import { useRelayMembershipEvent, useSelfPubkey } from "../hooks.ts";
import { communityRoleFromMembershipEvent } from "../lib/capability.ts";
import { ModerationQueueGroupCard } from "./ModerationQueueGroup.tsx";
import { ModerationAuditList } from "./ModerationAuditList.tsx";

/**
 * The moderation queue — the surface this client was missing.
 *
 * Web could already *act* on moderation from a message row, and members could
 * file kind-1984 reports, but there was nowhere to work through what they
 * filed. This pane is that place: open reports grouped by what they point at,
 * ordered by severity, each with what was reported, who reported it, what has
 * already been done to that target, and the resolutions the viewer may
 * actually carry out.
 *
 * **The gate is the relay's own answer, not a client guess.** Every
 * `/moderation/*` read is authorized against `ModerationAction::ViewQueue`,
 * which only a community owner/admin holds, so a member who opens this pane
 * gets one 403 and the explanation below. Mirroring the gate client-side (what
 * the desktop client does) would need the membership snapshot to have arrived
 * before the pane could say anything at all, and would still be a guess about
 * a policy the relay owns.
 *
 * The per-resolution authority is a different question and IS computed
 * client-side, because it decides what to render rather than what to allow —
 * see `lib/queueAuthority.ts`, which mirrors the relay arm by arm and does not
 * follow the desktop client where the desktop client and the relay disagree.
 */
export function ModerationQueueView() {
  const reports = useModerationReports();
  const audit = useModerationAudit();
  const resolveReport = useResolveReport();
  const selfPubkey = useSelfPubkey();
  const viewerRole = useViewerCommunityRole();
  const membershipEvent = useRelayMembershipEvent();
  const { channels } = useChannels();
  const [busyTarget, setBusyTarget] = useState<string | null>(null);

  const groups = useMemo(
    () => buildModerationQueue(reports.rows, audit.rows),
    [reports.rows, audit.rows],
  );

  const channelIds = useMemo(
    () =>
      groups
        .map((group) => group.channelId)
        .filter((id): id is string => typeof id === "string"),
    [groups],
  );
  const channelRoles = useViewerChannelRoles(channelIds);

  const reportedEventIds = useMemo(
    () =>
      groups
        .filter((group) => group.targetKind === "event")
        .map((group) => group.target),
    [groups],
  );
  const reportedEvents = useReportedEvents(reportedEventIds);

  // Reporters, plus every reported author we managed to resolve.
  const profilePubkeys = useMemo(() => {
    const keys = new Set<string>();
    for (const group of groups) {
      for (const report of group.reports) {
        keys.add(report.reporterPubkey);
      }
      if (group.targetKind === "pubkey") {
        keys.add(group.target);
      } else {
        const author = reportedEvents.get(group.target)?.pubkey;
        if (author) {
          keys.add(author.toLowerCase());
        }
      }
    }
    return [...keys];
  }, [groups, reportedEvents]);
  const profiles = useProfiles(profilePubkeys);

  /**
   * The author a member-directed enforcement would act on: the target itself
   * for a pubkey report, and the reported event's own signer for an event
   * report. The signer, never a `p` tag — a relay-signed REST message carries
   * the human in a `p` tag and could otherwise be made to name someone else.
   */
  const authorOf = (group: ModerationQueueGroup): string | null => {
    if (group.targetKind === "pubkey") {
      return group.target;
    }
    const pubkey = reportedEvents.get(group.target)?.pubkey;
    return pubkey ? pubkey.toLowerCase() : null;
  };

  const handleResolve = async (
    group: ModerationQueueGroup,
    action: ResolutionAction,
    timeoutExpiresAt?: number,
  ): Promise<void> => {
    const open = openReports(group);
    if (open.length === 0) {
      toast.error("Nothing left to resolve on this report.");
      return;
    }
    setBusyTarget(group.targetKey);
    try {
      const outcome = await resolveReport({
        action,
        reportEventIds: open.map((report) => report.reportEventId),
        targetEventId: group.targetKind === "event" ? group.target : null,
        channelId: group.channelId,
        authorPubkey: authorOf(group),
        timeoutExpiresAt,
      });
      // Say what happened, including the awkward middle case where the
      // enforcement landed and a report could not be closed.
      if (!outcome.enforced) {
        toast.error(outcome.message ?? "The relay refused the action.");
      } else if (outcome.resolved === 0 && outcome.attempted > 0) {
        toast.error(
          outcome.message ??
            "The action was applied, but the report stayed open.",
        );
      } else if (outcome.resolved < outcome.attempted) {
        toast.warning(
          `Applied, and closed ${outcome.resolved} of ${outcome.attempted} reports. ${
            outcome.message ?? ""
          }`.trim(),
        );
      } else {
        toast.success(
          action === "dismiss"
            ? "Report dismissed"
            : action === "escalate"
              ? "Report escalated"
              : "Report resolved",
        );
      }
    } finally {
      setBusyTarget(null);
      reports.refetch();
      audit.refetch();
    }
  };

  if (reports.forbidden) {
    return (
      <Pane>
        <p
          className="rounded-lg border border-dashed border-border/70 bg-background/40 px-3 py-6 text-center text-sm text-muted-foreground"
          data-testid="moderation-queue-forbidden"
        >
          The moderation queue is available to community moderators only.
          {viewerRole ? ` You are signed in as a ${viewerRole}.` : ""}
        </p>
      </Pane>
    );
  }

  return (
    <Pane>
      <Tabs defaultValue="queue">
        <TabsList>
          <TabsTrigger data-testid="moderation-tab-queue" value="queue">
            Queue
          </TabsTrigger>
          <TabsTrigger data-testid="moderation-tab-audit" value="audit">
            Audit log
          </TabsTrigger>
        </TabsList>
        <TabsContent value="queue">
          {reports.error ? (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {reports.error}
            </p>
          ) : reports.loading ? (
            <p className="text-sm text-muted-foreground">Loading reports…</p>
          ) : groups.length === 0 ? (
            <p
              className="rounded-lg border border-dashed border-border/70 bg-background/40 px-3 py-6 text-center text-sm text-muted-foreground"
              data-testid="moderation-queue-empty"
            >
              No open reports. The queue is clear.
            </p>
          ) : (
            <div className="space-y-3" data-testid="moderation-queue-list">
              {groups.map((group) => {
                const author = authorOf(group);
                const reportedEvent =
                  group.targetKind === "event"
                    ? (reportedEvents.get(group.target) ?? null)
                    : null;
                return (
                  <ModerationQueueGroupCard
                    authority={queueAuthority({
                      actorCommunityRole: viewerRole,
                      actorChannelRole: group.channelId
                        ? (channelRoles.get(group.channelId) ?? null)
                        : null,
                      targetCommunityRole: communityRoleFromMembershipEvent(
                        membershipEvent,
                        author,
                      ),
                      targetKind: group.targetKind,
                      hasChannel: group.channelId !== null,
                      targetAuthorKnown: author !== null,
                      targetIsSelf:
                        author !== null &&
                        selfPubkey !== null &&
                        author === selfPubkey.toLowerCase(),
                    })}
                    busy={busyTarget === group.targetKey}
                    channelName={
                      channels.find((channel) => channel.id === group.channelId)
                        ?.name ?? null
                    }
                    group={group}
                    key={group.targetKey}
                    onResolve={(action, timeoutExpiresAt) =>
                      void handleResolve(group, action, timeoutExpiresAt)
                    }
                    profiles={profiles}
                    reportedAuthorPubkey={author}
                    reportedContent={reportedEvent?.content ?? null}
                  />
                );
              })}
            </div>
          )}
        </TabsContent>
        <TabsContent value="audit">
          <ModerationAuditList
            actions={audit.rows}
            error={audit.error}
            loading={audit.loading}
            nameOf={(pubkey) =>
              profiles.get(pubkey)?.displayName?.trim() ||
              truncatePubkey(pubkey)
            }
          />
        </TabsContent>
      </Tabs>
    </Pane>
  );
}

/** The pane chrome — a heading and a scroll region, like the other shell views. */
function Pane({ children }: { children: React.ReactNode }) {
  return (
    <section
      className="buzz-content-scrollbar flex h-full min-h-0 flex-1 flex-col overflow-y-auto p-4"
      data-testid="moderation-queue"
    >
      <div className="mx-auto w-full max-w-3xl">
        <header className="mb-3">
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            <ShieldAlert aria-hidden="true" className="h-5 w-5" />
            Moderation
          </h1>
          <p className="text-sm text-muted-foreground">
            Review reported content and take action. Visible to community
            moderators only.
          </p>
        </header>
        {children}
      </div>
    </section>
  );
}
