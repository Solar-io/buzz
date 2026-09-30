import type { ChannelSummary } from "@/features/channels/useChannels";
import { HomeInboxRoute } from "@/features/home/ui/HomeInboxRoute";
import { OnboardingPane } from "@/features/onboarding";
import { ProjectsScreen } from "@/features/projects/ui/ProjectsScreen";
import { PulseScreen } from "@/features/pulse/ui/PulseScreen";
import { RemindersPanel } from "@/features/reminders/ui/RemindersPanel";
import { VitalsBlock } from "@/features/vitals/ui/VitalsBlock";
import { WorkTab } from "@/features/work/ui/WorkTab";
import { WorkflowsPage } from "@/features/workflows/ui/WorkflowsPage";
import type { ReactNode } from "react";
import type { ShellView } from "./reposSearch.ts";

/**
 * The shell's full-page `?view=` panes (Work, Channels, Inbox, Reminders,
 * Pulse, Projects, Workflows, Onboarding). Lifted out of routes/repos.tsx unchanged so the
 * route can dock a kept-open thread beside them (the shell row's
 * RightPaneHost) without growing past the file-size ceiling.
 */
export function ShellViewPane({
  view,
  channels,
  selfPubkey,
  onClose,
  onOpenMessage,
  onOpenView,
  onJump,
  channelsPage,
}: {
  view: ShellView;
  channels: ChannelSummary[];
  selfPubkey: string | null;
  /** Leave the view (back to the bare shell). */
  onClose: () => void;
  /** Open a conversation, optionally at a message (?c=&m=). */
  onOpenMessage: (channelId: string, messageId?: string) => void;
  /** Switch to another view (Work rows open Workflows / Reminders). */
  onOpenView: (view: ShellView) => void;
  /** Raise the ⌘K panel (the phone Work page's Jump button). */
  onJump: () => void;
  /** The channel list as a page — the phone tab bar's Channels tab. */
  channelsPage: ReactNode;
}) {
  switch (view) {
    case "work":
      return (
        <WorkTab
          variant="page"
          channelId={null}
          onOpenMessage={onOpenMessage}
          onOpenChannel={onOpenMessage}
          onOpenView={onOpenView}
          onJump={onJump}
          vitals={<VitalsBlock variant="strip" />}
        />
      );
    case "channels":
      return channelsPage;
    case "onboarding":
      return <OnboardingPane />;
    case "projects":
      return <ProjectsScreen />;
    case "pulse":
      return <PulseScreen onClose={onClose} selfPubkey={selfPubkey} />;
    case "reminders":
      return (
        <RemindersPanel
          channels={channels}
          onClose={onClose}
          onJump={(destination) =>
            onOpenMessage(destination.channelId, destination.messageId)
          }
          selfPubkey={selfPubkey}
        />
      );
    case "workflows":
      return <WorkflowsPage />;
    case "inbox":
      return (
        <HomeInboxRoute
          channels={channels}
          selfPubkey={selfPubkey}
          onOpenChannel={onOpenMessage}
        />
      );
  }
}
