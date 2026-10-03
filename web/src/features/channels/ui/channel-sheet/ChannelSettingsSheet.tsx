import { useState } from "react";
import { X } from "lucide-react";
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
import { MembersTab } from "./MembersTab";
import { WorkflowsTab } from "./WorkflowsTab";

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
  memberContext?: {
    selfPubkey: string | null;
    agentPubkeys: ReadonlySet<string>;
  };
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
        <div className="flex min-h-16 shrink-0 items-center gap-3 border-b border-border px-4 pt-[env(safe-area-inset-top)] sm:min-h-20">
          <DialogClose
            disabled={busy}
            className="order-1 min-h-11 text-sm text-blue-ink sm:order-3 sm:flex sm:w-11 sm:items-center sm:justify-center"
          >
            <span className="sm:sr-only">Close</span>
            <X aria-hidden className="hidden size-4 sm:block" />
          </DialogClose>
          <div className="order-2 min-w-0 flex-1 sm:order-1">
            <p className="hidden text-2xs uppercase tracking-wider text-muted-foreground sm:block">
              Channel settings
            </p>
            <DialogTitle className="min-w-0 truncate text-center text-base sm:text-left sm:text-xl">
              # {props.channel.name}
            </DialogTitle>
          </div>
          <span className="order-3 w-9 sm:hidden" aria-hidden />
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
              disabled={busy}
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
                "min-h-11 min-w-0 flex-1 rounded-md px-1 text-sm capitalize text-ink-2",
                tab === id && "bg-card text-foreground shadow-sm",
              )}
            >
              {id[0].toUpperCase() + id.slice(1)}
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
          ) : tab === "members" && props.memberContext ? (
            <MembersTab
              channelId={props.channel.id}
              archived={props.channel.archived}
              {...props.memberContext}
            />
          ) : tab === "workflows" ? (
            <WorkflowsTab
              channelId={props.channel.id}
              writable={props.isMember && !props.channel.archived}
              onBusyChange={setBusy}
            />
          ) : (
            <p className="py-8 text-sm text-muted-foreground">
              Member management is coming in the next phase.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
