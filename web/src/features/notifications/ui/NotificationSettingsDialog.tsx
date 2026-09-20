import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";

import { isNativeIOS } from "@/shared/platform/native";
import { NativePushSettings } from "@/shared/platform/NativePush";

import { NotificationSettingsContent } from "./NotificationSettingsContent";

export interface NotificationSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Per-device notification settings, as a dialog.
 *
 * Every control here is local to this browser, which the screen says out
 * loud — the alternative is a user switching notifications on at their desk
 * and wondering why their laptop is silent.
 *
 * The controls themselves live in `NotificationSettingsContent`, shared with
 * the settings page's Notifications pane; this file is only the chrome around
 * them. The permission prompt fires from the switch's own change event, so
 * opening this dialog changes nothing about the gesture the browser demands.
 */
export function NotificationSettingsDialog({
  open,
  onOpenChange,
}: NotificationSettingsDialogProps) {
  if (isNativeIOS())
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Notifications</DialogTitle>
            <DialogDescription>Settings for this iPhone.</DialogDescription>
          </DialogHeader>
          <NativePushSettings />
        </DialogContent>
      </Dialog>
    );

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

        <NotificationSettingsContent onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
