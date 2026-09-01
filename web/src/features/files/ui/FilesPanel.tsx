import { useEffect, useState } from "react";
import { Folder, X } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import {
  getConfiguredFilesUrl,
  setConfiguredFilesUrl,
} from "@/features/files/filesConfig";

/**
 * Files panel — fills the main content area (chat + thinking columns
 * together; the sidebar stays). Opened from the sidebar's bottom-left
 * folder icon; the ✕ (or Esc) hands the area back to the conversation.
 * The URL comes from Settings (per-browser) or the build default; an
 * unconfigured panel collects it inline.
 */
export function FilesPanel({ onClose }: { onClose: () => void }) {
  const [url, setUrl] = useState(getConfiguredFilesUrl);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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
      {url ? (
        <iframe
          title="Files"
          src={url}
          className="min-h-0 flex-1 border-0 bg-background"
        />
      ) : (
        <FilesSetup onConfigured={setUrl} />
      )}
    </div>
  );
}

function FilesSetup({ onConfigured }: { onConfigured: (url: string) => void }) {
  const [entry, setEntry] = useState("");
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-8">
      <div className="max-w-md space-y-3 text-center">
        <p className="text-sm text-muted-foreground">
          Point Buzz at a web file manager on your network — FileBrowser and
          SFTPGo both work. It loads in this panel; the app keeps its own login.
        </p>
        <div className="flex gap-2">
          <Input
            value={entry}
            onChange={(event) => setEntry(event.target.value)}
            placeholder="https://files.your-network/"
            aria-label="File manager URL"
          />
          <Button
            size="sm"
            disabled={!entry.trim()}
            onClick={() => {
              const trimmed = entry.trim();
              setConfiguredFilesUrl(trimmed);
              onConfigured(trimmed);
            }}
          >
            Save
          </Button>
        </div>
        <p className="text-xs text-muted-foreground/70">
          Saved on this browser. Operators can also bake a default in at build
          time (VITE_FILES_PANEL_URL).
        </p>
      </div>
    </div>
  );
}
