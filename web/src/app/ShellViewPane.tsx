import type { ChannelSummary } from "@/features/channels/useChannels";
import { HomeInboxRoute } from "@/features/home/ui/HomeInboxRoute";
import { OnboardingPane } from "@/features/onboarding";
import { ProjectsScreen } from "@/features/projects/ui/ProjectsScreen";
import { PulseScreen } from "@/features/pulse/ui/PulseScreen";
import { RemindersPanel } from "@/features/reminders/ui/RemindersPanel";
import { WorkflowsPage } from "@/features/workflows/ui/WorkflowsPage";
import type { ShellView } from "./reposSearch.ts";

/**
 * The shell's full-page `?view=` panes (Inbox, Reminders, Pulse, Projects,
 * Workflows, Onboarding). Lifted out of routes/repos.tsx unchanged so the
 * route can dock a kept-open thread beside them (the shell row's
 * RightPaneHost) without growing past the file-size ceiling.
 */
export function ShellViewPane({
  view,
  channels,
  selfPubkey,
  onClose,
  onOpenMessage,
}: {
  view: ShellView;
  channels: ChannelSummary[];
  selfPubkey: string | null;
  /** Leave the view (back to the bare shell). */
  onClose: () => void;
  /** Open a conversation, optionally at a message (?c=&m=). */
  onOpenMessage: (channelId: string, messageId?: string) => void;
}) {
  switch (view) {
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
