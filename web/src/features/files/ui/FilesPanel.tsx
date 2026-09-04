import { useState } from "react";
import { Link } from "@tanstack/react-router";

import { useWebPanelDock } from "@/features/webPanels/hooks";
import { WebPanelDock } from "@/features/webPanels/ui/WebPanelDock";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";

import {
  getConfiguredFilesUrl,
  setConfiguredFilesUrl,
} from "@/features/files/filesConfig";

/**
 * The Files surface — now the web-panel dock.
 *
 * It kept its name and its props because the shell reaches it as "the folder
 * button", but what it renders is the general dock: several sites open as
 * tabs, each staying loaded while you switch between them, plus the sites the
 * user adds themselves. Files is simply the built-in entry, supplied by the
 * operator's `VITE_FILES_PANEL_URL` or by Settings.
 *
 * The first-run setup below survives from the previous version because it is
 * still the right thing when *nothing* is configured: asking for one URL is a
 * gentler start than an empty dock with an add button.
 */
export function FilesPanel({ onClose }: { onClose: () => void }) {
  const dock = useWebPanelDock();
  // Local state only so the setup form can hand the dock a URL without a
  // reload; the registry itself re-reads the stored value.
  const [, setFilesUrl] = useState(getConfiguredFilesUrl);

  // Setup is shown when there is nothing at all to dock — not merely when the
  // built-in Files URL is unset, because a user who added their own sites and
  // never set a Files URL has a perfectly good dock.
  if (dock.panels.length === 0) {
    return <FilesSetup onClose={onClose} onConfigured={setFilesUrl} />;
  }
  return <WebPanelDock onClose={onClose} />;
}

function FilesSetup({
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
            login. You can add more sites once this one is set.
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
