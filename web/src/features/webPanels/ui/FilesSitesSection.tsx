import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import { Button } from "@/shared/ui/button";

import { showWebView } from "../activeWebStore.ts";
import { useWebPanelDock } from "../hooks.ts";
import { AddSiteDialog } from "./AddSiteDialog.tsx";

/**
 * Settings → Files sites. The in-page tab strip, site buttons and "+" were
 * removed from the bar above embedded pages (Sam, 2026-09-26: keep only Full
 * screen and Open in new tab), so this is where extra Files sites are added,
 * removed, and picked: "Open" shows the site in the main pane, and the
 * sidebar's Files row reopens whichever Files site was used last.
 */
export function FilesSitesSection() {
  const dock = useWebPanelDock();
  const navigate = useNavigate();
  const [addOpen, setAddOpen] = useState(false);
  return (
    <section
      className="space-y-2 rounded-lg border border-border bg-card p-4"
      data-testid="files-sites-section"
    >
      <div className="flex items-center justify-between">
        <h2 className="font-medium">Files sites</h2>
        <Button
          onClick={() => setAddOpen(true)}
          size="sm"
          type="button"
          variant="ghost"
        >
          <Plus aria-hidden className="size-4" />
          Add a site
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Sites the Files row can show. Files opens the one you used last; open
        another from here.
      </p>
      {dock.panels.length === 0 ? (
        <p className="text-xs text-muted-foreground/70">No sites yet.</p>
      ) : (
        <ul className="space-y-1">
          {dock.panels.map((panel) => (
            <li className="flex items-center gap-2" key={panel.id}>
              <span className="min-w-0 flex-1 truncate text-sm">
                {panel.label}{" "}
                <span className="font-mono text-xs text-muted-foreground">
                  {panel.url}
                </span>
              </span>
              <Button
                onClick={() => {
                  showWebView({ kind: "files", panelId: panel.id });
                  void navigate({ to: "/repos" });
                }}
                size="sm"
                type="button"
                variant="outline"
              >
                Open
              </Button>
              {panel.custom ? (
                <button
                  aria-label={`Remove ${panel.label}`}
                  className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={() => dock.removeSite(panel.id)}
                  type="button"
                >
                  <Trash2 aria-hidden className="size-4" />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <AddSiteDialog
        onAdd={dock.addSite}
        onOpenChange={setAddOpen}
        open={addOpen}
      />
    </section>
  );
}
