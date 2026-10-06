import { type ComponentProps, type ReactNode, useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import { MessageToasts } from "@/features/channels/ui/MessageToasts";
import { openDm } from "@/features/dms/hooks";
import { AsksProvider } from "@/features/home/AsksProvider";
import { ItemsProvider } from "@/features/items/ItemsProvider";
import { NotificationRuntime } from "@/features/notifications/ui/NotificationRuntime";
import { ProfileActionsProvider } from "@/features/profile/ProfileActionsContext";
import { RemindMeLaterProvider } from "@/features/reminders/ui/RemindMeLaterProvider";
import { FileTabsProvider } from "@/features/shelf/FileTabsProvider";
import { ShelfProvider } from "@/features/shelf/ShelfProvider";
import { StageRoute } from "@/features/stage/ui/StageRoute";
import { WorkProvider } from "@/features/work/WorkProvider";
import { WorkToasts } from "@/features/work/useWorkToasts";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";

type StageProps = ComponentProps<typeof StageRoute>;
type ToastProps = ComponentProps<typeof MessageToasts>;
type WorkProps = ComponentProps<typeof WorkProvider>;

/**
 * The signed-in shell's always-mounted providers and runtimes, lifted out of
 * `routes/repos.tsx` (web redesign Phase 0), plus the Work tab's
 * subscriptions and toasts (Phase 1), the Items fold (Phase 5), and the
 * Shelf's shares and open file tabs (Phase 6). Everything
 * in it belongs at the shell and nowhere else: once per app, outliving every
 * view.
 */
export function ShellProviders({
  channels,
  selfPubkey,
  stage,
  toasts,
  work,
  onDmOpened,
  children,
}: {
  channels: ToastProps["channels"];
  selfPubkey: string | null;
  /** The open conversation, for the Stage overlay. */
  stage: Omit<StageProps, "selfPubkey">;
  toasts: Omit<ToastProps, "selfPubkey" | "channels" | "onReply">;
  /** The Work tab's shell inputs: known agents and the live read markers. */
  work: Pick<WorkProps, "agentPubkeys" | "readState">;
  /** A profile card opened (or created) a DM. */
  onDmOpened: (channelId: string) => void;
  children: ReactNode;
}) {
  const navigate = useNavigate({ from: "/repos" });
  const { session } = useRelaySession();
  const openFileMessage = useCallback(
    (c: string, m: string) => void navigate({ to: "/repos", search: { c, m } }),
    [navigate],
  );
  const openShelf = useCallback(
    () => void navigate({ to: "/repos", search: { view: "shelf" } }),
    [navigate],
  );
  return (
    // AsksProvider owns the always-on asks badge + answer detection; once at
    // the shell, same discipline as NotificationRuntime. WorkProvider sits
    // inside it (it reads the asks feed) and owns the Work tab's own REQs.
    <AsksProvider channels={channels} selfPubkey={selfPubkey}>
      <WorkProvider channels={channels} selfPubkey={selfPubkey} {...work}>
        <ItemsProvider channels={channels} selfPubkey={selfPubkey}>
          <ShelfProvider channels={channels} selfPubkey={selfPubkey}>
            <FileTabsProvider
              onOpenMessage={openFileMessage}
              onOpenShelf={openShelf}
            >
              <WorkToasts
                selectedId={toasts.selectedId}
                onOpenChannel={toasts.onOpenChannel}
                onOpenMessage={(c, m) =>
                  void navigate({ to: "/repos", search: { c, m } })
                }
                onOpenView={(view) =>
                  void navigate({ to: "/repos", search: { view } })
                }
              />
              {/* Mounted at the shell so it outlives every route the signed-in app
          can be on; in the sidebar it died wherever the sidebar unmounted. It
          takes the shell's channel list rather than opening a second
          kind:39000 REQ. */}
              <NotificationRuntime
                selfPubkey={selfPubkey}
                channels={channels}
                onArrival={toasts.onArrival}
              />
              <StageRoute {...stage} selfPubkey={selfPubkey} />
              <RemindMeLaterProvider selfPubkey={selfPubkey}>
                {/* Same mount discipline as NotificationRuntime: once at the shell,
            so toasts survive every view. Inside the reminders provider, for
            the toast's Feedback. Channels and DMs alike arrive from the
            shell's one conversation-activity store. */}
                <MessageToasts
                  {...toasts}
                  selfPubkey={selfPubkey}
                  channels={channels}
                  agentPubkeys={work.agentPubkeys}
                  onReply={(c, m) =>
                    void navigate({
                      to: "/repos",
                      search: { c, m, reply: true },
                    })
                  }
                />
                {/* Profile cards open DMs; DM creation is the shell's job, and the
            row that raises the card renders under ChannelTimeline, so the
            callback reaches it by context rather than through files the shell
            does not own. The "Recent" list knows event and channel ids but
            not names, and cannot route — the shell owns both. */}
                <ProfileActionsProvider
                  channelName={(channelId) =>
                    channels.find((channel) => channel.id === channelId)
                      ?.name ?? ""
                  }
                  onOpenMessage={(channelId, messageId) => {
                    void navigate({
                      to: "/repos",
                      search: { c: channelId, m: messageId },
                    });
                  }}
                  onOpenDm={(pubkey) => {
                    void openDm(session, [pubkey]).then((result) => {
                      if (result.ok && result.channelId) {
                        onDmOpened(result.channelId);
                      }
                    });
                  }}
                >
                  {children}
                </ProfileActionsProvider>
              </RemindMeLaterProvider>
            </FileTabsProvider>
          </ShelfProvider>
        </ItemsProvider>
      </WorkProvider>
    </AsksProvider>
  );
}
