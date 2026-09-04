import { ExternalLink, Folder, Globe, Plus, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";

import { useTheme } from "@/shared/theme/ThemeProvider";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";

import { useWebPanelDock } from "../hooks.ts";
import { findPanel, withThemeParam } from "../lib/panelRegistry.ts";
import { MAX_PANEL_INSTANCES } from "../lib/panelSession.ts";
import { AddSiteDialog } from "./AddSiteDialog.tsx";

/** How long a frame may stay blank before we suggest opening it directly. */
const EMBED_STALL_MS = 8_000;

/**
 * The tabbed web-panel dock.
 *
 * Every open tab's iframe stays **mounted** and only the inactive ones are
 * hidden, which is the entire point of a dock over a single swappable frame:
 * switching tabs preserves scroll position, half-typed forms, and the session
 * the embedded site holds. Hiding is `hidden` + `pointer-events-none` rather
 * than unmounting, because unmounting is what would throw all of that away.
 *
 * A browser cannot force a site to embed. Sites that send
 * `X-Frame-Options: DENY` or a restrictive `frame-ancestors` render blank and
 * report nothing usable to the parent page, so the dock watches for a frame
 * that never fires `load` and offers to open it in a real tab instead of
 * leaving the user staring at white space. (The desktop has no equivalent
 * problem: its panels are native child webviews, not frames.)
 */
export function WebPanelDock({ onClose }: { onClose: () => void }) {
  const dock = useWebPanelDock();
  const { isDark } = useTheme();
  const [addOpen, setAddOpen] = useState(false);
  const [stalled, setStalled] = useState<Record<string, boolean>>({});
  const loadedRef = useRef<Set<string>>(new Set());

  // Open the first available site the first time the dock is shown, so the
  // panel is never an empty frame with a tab bar above it.
  const openedOnce = useRef(false);
  useEffect(() => {
    if (openedOnce.current || dock.instances.length > 0) {
      openedOnce.current = true;
      return;
    }
    const first = dock.panels[0];
    if (first) {
      openedOnce.current = true;
      dock.open(first.id);
    }
  }, [dock]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const active = dock.instances.find(
    (instance) => instance.instanceId === dock.activeInstanceId,
  );
  const activePanel = findPanel(dock.panels, active?.panelId ?? null);
  const atCap = dock.instances.length >= MAX_PANEL_INSTANCES;

  // One stall timer per open tab, armed when the tab appears and cancelled on
  // teardown. Arming it from the iframe's `ref` callback instead would re-arm
  // on every render, since an inline callback ref detaches and reattaches.
  useEffect(() => {
    const timers = dock.instances.map((instance) =>
      window.setTimeout(() => {
        if (!loadedRef.current.has(instance.instanceId)) {
          setStalled((current) => ({
            ...current,
            [instance.instanceId]: true,
          }));
        }
      }, EMBED_STALL_MS),
    );
    return () => {
      for (const timer of timers) {
        window.clearTimeout(timer);
      }
    };
  }, [dock.instances]);

  return (
    <div
      className="flex h-full min-h-0 w-full flex-col bg-background"
      data-testid="web-panel-dock"
    >
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-secondary px-3">
        <div
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
          data-testid="web-panel-tabs"
          role="tablist"
        >
          {dock.instances.map((instance) => {
            const panel = findPanel(dock.panels, instance.panelId);
            const selected = instance.instanceId === dock.activeInstanceId;
            return (
              <div
                className={cn(
                  "flex shrink-0 items-center gap-1 rounded-md border px-2 py-1",
                  selected
                    ? "border-border bg-background"
                    : "border-transparent hover:bg-accent/50",
                )}
                key={instance.instanceId}
              >
                <button
                  aria-selected={selected}
                  className="flex items-center gap-1.5 text-xs"
                  data-testid={`web-panel-tab-${instance.instanceId}`}
                  onClick={() => dock.activate(instance.instanceId)}
                  role="tab"
                  type="button"
                >
                  {panel?.custom ? (
                    <Globe aria-hidden className="size-3.5" />
                  ) : (
                    <Folder aria-hidden className="size-3.5" />
                  )}
                  <span className="max-w-32 truncate">
                    {panel?.label ?? "Unknown"}
                  </span>
                </button>
                <button
                  aria-label={`Close ${panel?.label ?? "tab"}`}
                  className="rounded-xs p-0.5 text-muted-foreground hover:text-foreground"
                  data-testid={`web-panel-close-${instance.instanceId}`}
                  onClick={() => dock.close(instance.instanceId)}
                  type="button"
                >
                  <X aria-hidden className="size-3" />
                </button>
              </div>
            );
          })}
        </div>

        <PanelOpener
          atCap={atCap}
          dock={dock}
          onAddSite={() => setAddOpen(true)}
        />

        {activePanel ? (
          <a
            aria-label={`Open ${activePanel.label} in a new tab`}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            href={activePanel.url}
            rel="noreferrer noopener"
            target="_blank"
          >
            <ExternalLink aria-hidden className="size-4" />
          </a>
        ) : null}
        <button
          aria-label="Close panels"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          data-testid="web-panel-dock-close"
          onClick={onClose}
          type="button"
        >
          <X aria-hidden className="size-4" />
        </button>
      </div>

      <div className="relative min-h-0 flex-1">
        {dock.instances.map((instance) => {
          const panel = findPanel(dock.panels, instance.panelId);
          if (!panel) {
            return null;
          }
          const selected = instance.instanceId === dock.activeInstanceId;
          return (
            <iframe
              // Inactive frames stay MOUNTED and are hidden with opacity, not
              // `display: none` or an unmount: keeping the document alive is
              // what preserves scroll, form state and the embedded site's
              // session across a tab switch. `inert` takes them out of the
              // focus order so Tab cannot land inside an invisible frame.
              className={cn(
                "absolute inset-0 h-full w-full border-0 bg-background",
                selected ? "z-10" : "pointer-events-none opacity-0",
              )}
              data-testid={`web-panel-frame-${instance.instanceId}`}
              inert={!selected}
              key={instance.instanceId}
              onLoad={() => {
                loadedRef.current.add(instance.instanceId);
                setStalled((current) =>
                  current[instance.instanceId]
                    ? { ...current, [instance.instanceId]: false }
                    : current,
                );
              }}
              src={withThemeParam(panel.url, isDark)}
              title={panel.label}
            />
          );
        })}

        {dock.instances.length === 0 ? <EmptyDock /> : null}

        {active && stalled[active.instanceId] && activePanel ? (
          <div
            className="absolute inset-x-0 bottom-0 z-20 flex items-center justify-between gap-3 border-t border-border bg-card/95 px-4 py-2"
            data-testid="web-panel-stalled"
          >
            <p className="min-w-0 text-xs text-muted-foreground">
              {activePanel.label} has not rendered. Some sites refuse to be
              embedded in another page.
            </p>
            <Button asChild size="sm" variant="outline">
              <a
                href={activePanel.url}
                rel="noreferrer noopener"
                target="_blank"
              >
                Open in a new tab
              </a>
            </Button>
          </div>
        ) : null}
      </div>

      <AddSiteDialog
        onAdd={dock.addSite}
        onOpenChange={setAddOpen}
        open={addOpen}
      />
    </div>
  );
}

function PanelOpener({
  dock,
  atCap,
  onAddSite,
}: {
  dock: ReturnType<typeof useWebPanelDock>;
  atCap: boolean;
  onAddSite: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      {dock.panels.map((panel) => (
        <span className="group/site flex items-center" key={panel.id}>
          <button
            className="rounded-md px-2 py-1 text-2xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
            data-testid={`web-panel-open-${panel.id}`}
            disabled={atCap}
            onClick={() => dock.focusOrOpen(panel.id)}
            title={atCap ? `At most ${MAX_PANEL_INSTANCES} tabs` : panel.url}
            type="button"
          >
            {panel.label}
          </button>
          {panel.custom ? (
            <button
              aria-label={`Remove ${panel.label} from the dock`}
              className="rounded-xs p-0.5 text-muted-foreground opacity-0 transition-opacity group-hover/site:opacity-100"
              data-testid={`web-panel-remove-${panel.id}`}
              onClick={() => dock.removeSite(panel.id)}
              type="button"
            >
              <Trash2 aria-hidden className="size-3" />
            </button>
          ) : null}
        </span>
      ))}
      <button
        aria-label="Add a site"
        className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        data-testid="web-panel-add-site"
        onClick={onAddSite}
        type="button"
      >
        <Plus aria-hidden className="size-4" />
      </button>
    </div>
  );
}

function EmptyDock() {
  return (
    <div
      className="absolute inset-0 z-20 flex h-full items-center justify-center p-8"
      data-testid="web-panel-empty"
    >
      <div className="max-w-md space-y-3 text-center">
        <p className="text-sm text-muted-foreground">
          No sites yet. Add a web file manager or any internal tool — it opens
          as a tab here and stays loaded while you switch between them.
        </p>
        <p className="text-xs text-muted-foreground/70">
          Buzz ships no file server of its own; the operator can also bake a
          default in at build time, or set one in{" "}
          <Link className="underline" to="/repos/settings">
            Settings
          </Link>
          .
        </p>
      </div>
    </div>
  );
}
