import { useState } from "react";
import { toast } from "sonner";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Switch } from "@/shared/ui/switch";
import { useNotificationPermission, useNotificationSettings } from "../hooks";
import { notificationCopy } from "../lib/notificationCopy.ts";
import type {
  NotificationMode,
  NotificationPermissionState,
} from "../lib/notifyDecision.ts";
import { promptForNotificationPermission } from "../lib/permissionStore.ts";
import { updateNotificationSettings } from "../lib/settingsStore.ts";

const MODES: { value: NotificationMode; label: string; hint: string }[] = [
  {
    value: "all",
    label: "All messages",
    hint: "Every message in a channel you have not muted.",
  },
  {
    value: "mentions",
    label: "Mentions and DMs",
    hint: "Only messages that @mention you, and direct messages.",
  },
  { value: "none", label: "Nothing", hint: "No notifications, no tab badge." },
];

/**
 * What the browser currently says, in the browser's own terms.
 *
 * `denied` is the case worth spelling out: the page cannot re-prompt, so an
 * "Allow notifications" button here would be a button that does nothing. The
 * only honest thing to show is where the user has to go instead.
 */
function permissionCopy(permission: NotificationPermissionState): {
  tone: "ok" | "warn" | "info";
  text: string;
} {
  switch (permission) {
    case "granted":
      return { tone: "ok", text: "Your browser is allowing notifications." };
    case "denied":
      return {
        tone: "warn",
        text: "Your browser is blocking notifications for this site. Buzz cannot ask again — allow them in your browser's site settings for this page.",
      };
    case "unsupported":
      return {
        tone: "warn",
        text: "This browser does not support web notifications. The tab badge still works.",
      };
    case "default":
      return {
        tone: "info",
        text: "Your browser has not been asked yet. Turning notifications on will ask.",
      };
  }
}

export interface NotificationSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Per-device notification settings.
 *
 * Every control here is local to this browser, which the screen says out
 * loud — the alternative is a user switching notifications on at their desk
 * and wondering why their laptop is silent.
 */
export function NotificationSettingsDialog({
  open,
  onOpenChange,
}: NotificationSettingsDialogProps) {
  const settings = useNotificationSettings();
  const permission = useNotificationPermission();
  const [asking, setAsking] = useState(false);
  const status = permissionCopy(permission);

  // Turning the switch ON is the user gesture the browser demands, so the
  // prompt is raised from here and nowhere else. Turning it off never asks.
  const onToggleDesktop = async (next: boolean) => {
    if (!next) {
      updateNotificationSettings({ desktopEnabled: false });
      return;
    }
    updateNotificationSettings({ desktopEnabled: true });
    if (permission === "granted" || permission === "unsupported") {
      return;
    }
    setAsking(true);
    try {
      const result = await promptForNotificationPermission();
      if (result === "denied") {
        toast.error("Your browser blocked notifications for this site.");
      }
    } finally {
      setAsking(false);
    }
  };

  const sendTest = () => {
    if (permission !== "granted") {
      toast.error(status.text);
      return;
    }
    const copy = notificationCopy({
      authorName: "Buzz",
      channelName: "",
      isDm: true,
      content: "Notifications are working on this device.",
      channelId: "test",
    });
    try {
      // eslint-disable-next-line no-new -- the constructor IS the side effect
      new Notification(copy.title, { body: copy.body, tag: copy.tag });
      toast.success("Test notification sent.");
    } catch {
      toast.error("Your browser refused to show the notification.");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-[460px]"
        data-testid="notification-settings-dialog"
      >
        <DialogHeader>
          <DialogTitle>Notifications</DialogTitle>
          <DialogDescription>
            These settings apply to this browser only.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5 pt-1">
          <section className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium">Desktop notifications</p>
                <p className="text-2xs text-muted-foreground">
                  Pop a system notification when a message arrives.
                </p>
              </div>
              <Switch
                aria-label="Desktop notifications"
                checked={settings.desktopEnabled}
                data-testid="notification-desktop-toggle"
                disabled={asking || permission === "unsupported"}
                onCheckedChange={(next) => void onToggleDesktop(next)}
              />
            </div>
            <p
              className={cn(
                "rounded-md border px-2.5 py-2 text-2xs",
                status.tone === "ok" &&
                  "border-emerald-500/40 text-emerald-600 dark:text-emerald-400",
                status.tone === "warn" &&
                  "border-amber-500/40 text-amber-600 dark:text-amber-400",
                status.tone === "info" && "border-border text-muted-foreground",
              )}
              data-testid="notification-permission-status"
              data-permission={permission}
            >
              {status.text}
            </p>
          </section>

          <fieldset className="flex flex-col gap-2">
            <legend className="pb-2 text-sm font-medium">
              What notifies you
            </legend>
            <div className="flex flex-col gap-1">
              {MODES.map((option) => (
                <label
                  className={cn(
                    "flex cursor-pointer items-start gap-2 rounded-md border px-2.5 py-2",
                    settings.mode === option.value
                      ? "border-primary bg-accent"
                      : "border-border hover:bg-accent/50",
                  )}
                  key={option.value}
                >
                  <input
                    checked={settings.mode === option.value}
                    className="mt-1 accent-primary"
                    data-testid={`notification-mode-${option.value}`}
                    name="notification-mode"
                    onChange={() =>
                      updateNotificationSettings({ mode: option.value })
                    }
                    type="radio"
                    value={option.value}
                  />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-sm">{option.label}</span>
                    <span className="text-2xs text-muted-foreground">
                      {option.hint}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <section className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium">Unread count in the tab</p>
              <p className="text-2xs text-muted-foreground">
                Shows a count in the browser tab while Buzz is in the
                background.
              </p>
            </div>
            <Switch
              aria-label="Unread count in the tab"
              checked={settings.titleBadgeEnabled}
              data-testid="notification-badge-toggle"
              onCheckedChange={(next) =>
                updateNotificationSettings({ titleBadgeEnabled: next })
              }
            />
          </section>

          <div className="flex items-center justify-between gap-2 pt-1">
            <Button
              data-testid="notification-test"
              onClick={sendTest}
              size="sm"
              type="button"
              variant="ghost"
            >
              Send a test notification
            </Button>
            <Button
              data-testid="notification-settings-done"
              onClick={() => onOpenChange(false)}
              size="sm"
              type="button"
            >
              Done
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
