import { useEffect } from "react";
import { Folder, X } from "lucide-react";
import { FILES_PANEL_URL } from "@/features/files/webPanels";

/**
 * Files panel — fills the main content area (chat + thinking columns
 * together; the sidebar stays). Opened from the sidebar's bottom-left
 * folder icon; the ✕ (or Esc) hands the area back to the conversation.
 */
export function FilesPanel({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!FILES_PANEL_URL) {
    return (
      <div className="flex h-full min-h-0 w-full flex-col bg-background">
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-secondary px-4">
          <div className="flex items-center gap-2">
            <Folder aria-hidden className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-base font-semibold">Files</h2>
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
        <div className="flex min-h-0 flex-1 items-center justify-center p-8">
          <p className="max-w-md text-center text-sm text-muted-foreground">
            No file manager configured. Set{" "}
            <code className="rounded bg-accent px-1 font-mono text-xs">
              VITE_FILES_PANEL_URL
            </code>{" "}
            at build time to the web file manager this Buzz should embed
            (see web/docs/COMPATIBILITY.md).
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-secondary px-4">
        <div className="flex items-center gap-2">
          <Folder aria-hidden className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">Files</h2>
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
