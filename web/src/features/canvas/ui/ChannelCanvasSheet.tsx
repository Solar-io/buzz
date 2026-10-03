import { Dialog, DialogContent, DialogTitle } from "@/shared/ui/dialog";
import { Button } from "@/shared/ui/button";
import type {
  ChannelCanvasDoc,
  ChannelCanvasPhase,
} from "../lib/channelCanvas.ts";
import { ChannelCanvasView } from "./ChannelCanvasView";

/** The channel Canvas tab becomes a full-screen document below the dock breakpoint. */
export function ChannelCanvasSheet({
  channelId,
  doc,
  phase,
  onClose,
}: {
  channelId: string;
  doc: ChannelCanvasDoc | null;
  phase: ChannelCanvasPhase;
  onClose: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        data-testid="channel-canvas-sheet"
        className="fixed inset-0 flex h-dvh w-full max-w-none flex-col gap-0 overflow-hidden rounded-none p-0 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2">
          <DialogTitle className="text-base">Canvas</DialogTitle>
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            className="min-h-11 text-blue-ink"
          >
            Close canvas
          </Button>
        </div>
        <div className="min-h-0 flex-1">
          <ChannelCanvasView
            key={channelId}
            channelId={channelId}
            doc={doc}
            phase={phase}
            expanded
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
