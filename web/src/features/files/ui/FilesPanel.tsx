import { useState } from "react";
import { Link } from "@tanstack/react-router";

import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";

import { setConfiguredFilesUrl } from "@/features/files/filesConfig";

/**
 * First-run Files setup, shown by the web layer when Files is opened with
 * nothing configured: asking for one URL is a gentler start than an empty
 * page. Once saved, the built-in "files" site exists and the layer shows it.
 * More sites, and changes, live in Settings.
 */
export function FilesSetup({
  onClose,
  onConfigured,
}: {
  onClose: () => void;
  onConfigured: (url: string) => void;
}) {
  const [entry, setEntry] = useState("");
  return (
    <div
      className="flex h-full min-h-0 w-full flex-col bg-background"
      data-testid="files-setup"
    >
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-secondary px-4">
        <h2 className="text-base font-semibold">Files</h2>
        <Button onClick={onClose} size="sm" type="button" variant="ghost">
          Close
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-8">
        <div className="max-w-md space-y-3 text-center">
          <p className="text-sm text-muted-foreground">
            Point Buzz at a web file manager on your network — FileBrowser and
            SFTPGo both work. It loads in this panel; the app keeps its own
            login. You can add more sites in Settings once this one is set.
          </p>
          <div className="flex gap-2">
            <Input
              aria-label="File manager URL"
              onChange={(event) => setEntry(event.target.value)}
              placeholder="https://files.your-network/"
              value={entry}
            />
            <Button
              disabled={!entry.trim()}
              onClick={() => {
                const trimmed = entry.trim();
                setConfiguredFilesUrl(trimmed);
                onConfigured(trimmed);
              }}
              size="sm"
            >
              Save
            </Button>
          </div>
          <p className="text-xs text-muted-foreground/70">
            Saved on this browser. Operators can also bake a default in at build
            time (VITE_FILES_PANEL_URL), or change it later in{" "}
            <Link className="underline" to="/repos/settings">
              Settings
            </Link>
            .
          </p>
        </div>
      </div>
    </div>
  );
}
