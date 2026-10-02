import { useState } from "react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/shared/ui/dialog";
import { cn } from "@/shared/lib/cn";
import type { ChannelSummary } from "../../useChannels";
import type { ChannelMetadataPatch } from "../../lib/channelMetadataEdit.ts";
import { AboutTab } from "./AboutTab";

export type ChannelSettingsTab = "about" | "members" | "workflows";
export interface ChannelSettingsSheetProps {
  channel: ChannelSummary;
  initialTab: ChannelSettingsTab;
  onClose: () => void;
  onEdit: (patch: ChannelMetadataPatch) => Promise<void>;
  onDelete: () => Promise<void>;
  onLeave: () => Promise<void>;
  onJoin: () => Promise<void>;
  onCanvas: () => void;
  onTemplate: () => Promise<void>;
  onMute: () => void;
  muted: boolean;
  isMember: boolean;
  memberCount: number;
  agentCount: number;
}

/** A modal sheet over the conversation; it never occupies a right-pane tab. */
export function ChannelSettingsSheet(props: ChannelSettingsSheetProps) {
  const [tab, setTab] = useState(props.initialTab);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (issue) {
      setError(
        issue instanceof Error
          ? issue.message
          : "Could not change the channel.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) props.onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        data-testid="channel-settings-sheet"
        className="fixed inset-y-0 right-0 left-auto flex h-dvh w-full max-w-none flex-col gap-0 overflow-hidden rounded-none p-0 sm:w-[30rem] sm:max-w-[30rem]"
      >
        <div className="flex min-h-16 shrink-0 items-center gap-3 border-b border-border px-4 pt-[env(safe-area-inset-top)]">
          <DialogClose
            disabled={busy}
            className="min-h-11 text-sm text-blue-ink"
          >
            Close
          </DialogClose>
          <DialogTitle className="min-w-0 flex-1 truncate text-center text-base">
            # {props.channel.name}
          </DialogTitle>
          <span className="w-9" aria-hidden />
        </div>
        <DialogDescription className="sr-only">
          Channel settings
        </DialogDescription>
        <div
          role="tablist"
          aria-label="Channel settings"
          className="mx-4 mt-4 flex shrink-0 rounded-lg bg-muted p-1"
        >
          {(["about", "members", "workflows"] as const).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`channel-tab-${id}`}
              aria-controls="channel-settings-panel"
              aria-selected={tab === id}
              tabIndex={tab === id ? 0 : -1}
              onKeyDown={(event) => {
                const tabs = ["about", "members", "workflows"] as const;
                const next =
                  event.key === "ArrowRight"
                    ? (tabs.indexOf(id) + 1) % 3
                    : event.key === "ArrowLeft"
                      ? (tabs.indexOf(id) + 2) % 3
                      : event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? 2
                          : null;
                if (next !== null) {
                  event.preventDefault();
                  setTab(tabs[next]);
                  document.getElementById(`channel-tab-${tabs[next]}`)?.focus();
                }
              }}
              onClick={() => setTab(id)}
              className={cn(
                "min-h-11 min-w-0 flex-1 rounded-md px-1 text-sm capitalize text-ink2",
                tab === id && "bg-card text-foreground shadow-sm",
              )}
            >
              {id}
              {id === "members" ? ` (${props.memberCount})` : ""}
            </button>
          ))}
        </div>
        <div
          role="tabpanel"
          id="channel-settings-panel"
          aria-labelledby={`channel-tab-${tab}`}
          className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]"
        >
          {error && (
            <p
              role="alert"
              className="mt-4 break-words rounded-lg border border-coral-line bg-coral-wash p-3 text-sm text-coral-ink"
            >
              {error}
            </p>
          )}
          {tab === "about" ? (
            <AboutTab
              {...props}
              busy={busy}
              run={run}
              onMembers={() => setTab("members")}
            />
          ) : (
            <p className="py-8 text-sm text-muted-foreground">
              {tab === "members"
                ? "Member management is coming in the next phase."
                : "Workflow management is coming in a later phase."}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
