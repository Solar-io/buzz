import { X } from "lucide-react";

import { Button } from "@/shared/ui/button";

import { PulseView } from "./PulseView.tsx";

/**
 * Pulse as a full-pane overlay in the app shell, next to the Files panel.
 *
 * The desktop gives Pulse its own route with a profile side-panel
 * (`desktop/src/features/pulse/ui/PulseScreen.tsx`). The web shell renders
 * one content pane at a time and owns routing, so this is the same content
 * with the shell's own dismiss affordance and no second panel: the web has no
 * `UserProfilePanel` to open.
 */
export function PulseScreen({
  onClose,
  selfPubkey,
}: {
  onClose: () => void;
  selfPubkey: string | null;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="pulse-screen">
      <header className="flex shrink-0 items-center justify-between border-b border-border/50 px-4 py-2">
        <h1 className="text-sm font-semibold text-foreground">Pulse</h1>
        <Button
          aria-label="Close Pulse"
          data-testid="pulse-close"
          onClick={onClose}
          size="icon"
          type="button"
          variant="ghost"
        >
          <X aria-hidden className="h-4 w-4" />
        </Button>
      </header>
      <div className="min-h-0 flex-1">
        <PulseView selfPubkey={selfPubkey} />
      </div>
    </div>
  );
}
