import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Button } from "@/shared/ui/button";
import { useSettingsNavGuard } from "../lib/useSettingsNavGuard";

/** Mount beside the screen's draft/save bar to protect every router exit. */
export function SettingsNavGuard(
  props: Parameters<typeof useSettingsNavGuard>[0],
) {
  const guard = useSettingsNavGuard(props);
  return (
    <Dialog
      open={guard.open}
      onOpenChange={(open) => {
        if (!open) guard.keepEditing();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogTitle>{guard.prompt}</DialogTitle>
        <DialogDescription>
          {props.busy
            ? "Wait for the desktop to answer before leaving."
            : "Your changes have not been saved."}
        </DialogDescription>
        <DialogFooter>
          <Button variant="outline" onClick={guard.keepEditing}>
            Keep editing
          </Button>
          <Button disabled={props.busy} onClick={guard.discardAndProceed}>
            Discard
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
