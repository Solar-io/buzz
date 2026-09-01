import { useEffect } from "react";
import { Folder, X } from "lucide-react";
import { FILES_PANEL_URL } from "@/features/files/webPanels";

/**
 * Files overlay — the desktop's docked Files panel as a full-cover layer:
 * themed chrome (header + close) around the file-manager app in an iframe.
 * Esc closes, like the search panel.
 */
export function FilesPanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) {
    return null;
  }
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Folder aria-hidden className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Files</h2>
        </div>
        <button
          type="button"
          aria-label="Close files"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <iframe
        title="Files"
        src={FILES_PANEL_URL}
        className="min-h-0 flex-1 border-0 bg-background"
      />
    </div>
  );
}
