import { invoke } from "@tauri-apps/api/core";
import { Globe } from "lucide-react";
import { toast } from "sonner";

import { WEB_PANELS, type WebPanelDef } from "./webPanels.config";

/**
 * The merged panel registry: the static `WEB_PANELS` config plus the
 * owner-added custom sites Rust keeps in its own store.
 *
 * The IPC contract is deliberately narrow: `list_custom_panels` returns
 * `{id, label, title}` and NEVER a url, so a custom panel def here carries
 * `url: null` and `render: "native"` — there is nothing for an iframe
 * fallback to load, and the CSP stays a static compile-time list. If the
 * list cannot be loaded (corrupt store, missing backend), customs are
 * disabled for the run and static panels are unaffected — the same
 * fail-closed posture as the Rust side.
 */

export type CustomPanelInfo = {
  id: string;
  label: string;
  title: string;
};

export type CustomPanelPhase = "unloaded" | "loading" | "ready" | "failed";

let phase: CustomPanelPhase = "unloaded";
let customs: readonly CustomPanelInfo[] = [];
let readyPromise: Promise<void> | null = null;
let loaderForTests: (() => Promise<unknown>) | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toDef(info: CustomPanelInfo): WebPanelDef {
  return {
    id: info.id,
    label: info.label,
    title: info.title || info.label,
    icon: Globe,
    url: null,
    render: "native",
    custom: true,
  };
}

/** Tolerate a hostile or malformed backend payload: keep only entries that
 *  look like custom panel info. Rust owns trust; this only avoids crashes. */
function sanitizeInfos(raw: unknown): CustomPanelInfo[] {
  if (!Array.isArray(raw)) return [];
  const infos: CustomPanelInfo[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const { id, label, title } = entry as Record<string, unknown>;
    if (typeof id !== "string" || id.length === 0) continue;
    if (typeof label !== "string" || label.length === 0) continue;
    infos.push({
      id,
      label,
      title: typeof title === "string" && title.length > 0 ? title : label,
    });
  }
  return infos;
}

async function runLoad(): Promise<void> {
  phase = "loading";
  try {
    const raw = loaderForTests
      ? await loaderForTests()
      : await invoke("list_custom_panels");
    customs = sanitizeInfos(raw);
    phase = "ready";
  } catch (error) {
    // Fail closed: customs are disabled for this run, statics unaffected.
    console.warn("custom web panels unavailable for this run", error);
    customs = [];
    phase = "failed";
  }
  notify();
}

/** Resolve the custom list once (idempotent). Never rejects: a failure
 *  settles the registry into its disabled-for-the-run state. */
export function customPanelsReady(): Promise<void> {
  if (readyPromise === null) {
    readyPromise = runLoad();
  }
  return readyPromise;
}

/** Force a re-fetch (after add/remove). */
export async function refreshCustomPanels(): Promise<void> {
  readyPromise = runLoad();
  await readyPromise;
}

export function subscribeWebPanelRegistry(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function customPanelPhase(): CustomPanelPhase {
  return phase;
}

export function customWebPanels(): readonly CustomPanelInfo[] {
  return customs;
}

/** Registry-aware lookup over statics + customs. */
export function getWebPanel(panelId: string | null): WebPanelDef | null {
  if (!panelId) return null;
  const custom = customs.find((info) => info.id === panelId);
  if (custom) return toDef(custom);
  return WEB_PANELS.find((panel) => panel.id === panelId) ?? null;
}

export function allWebPanels(): readonly WebPanelDef[] {
  return [...WEB_PANELS, ...customs.map(toDef)];
}

/**
 * Open the trusted add-site window (Rust-owned: a small fixed-size window
 * over the bundled add.html form — the only webview whose
 * `add_custom_panel` calls are honored; see the caller-label gate in
 * custom_panels.rs). Returns false when the invoke itself failed (a toast
 * was shown). Success is observed through `subscribeCustomPanelAdded`:
 * the add window types the values, Rust persists and broadcasts
 * `custom-panel-added`, and this registry refreshes in response.
 */
export async function openAddSiteWindow(): Promise<boolean> {
  try {
    await invoke("open_web_panel_add_window");
    return true;
  } catch (error) {
    toast.error("Couldn't open the add-site window", {
      description: describeError(error),
    });
    return false;
  }
}

// ── custom-panel-added channel ───────────────────────────────────────────

type AddedListener = (panel: CustomPanelInfo) => void;
type AddedEventInstaller = (
  handler: (raw: unknown) => void,
) => Promise<() => void>;

const addedListeners = new Set<AddedListener>();
let addedChannelPromise: Promise<() => void> | null = null;
let addedInstallerForTests: AddedEventInstaller | null = null;

function defaultAddedInstaller(
  handler: (raw: unknown) => void,
): Promise<() => void> {
  return import("@tauri-apps/api/event").then((api) =>
    api.listen("custom-panel-added", (event) => handler(event.payload)),
  );
}

/** Rust broadcast after a successful add; payload is a CustomPanelInfo
 *  (never a URL). Sanitize anyway — Rust owns trust, this avoids crashes. */
async function deliverCustomPanelAdded(raw: unknown): Promise<void> {
  const info = sanitizeInfos([raw])[0];
  if (!info) return;
  // Refresh BEFORE notifying, so a listener that resolves the new panel
  // (e.g. opening its tab) finds it in the registry.
  await refreshCustomPanels();
  for (const listener of addedListeners) {
    listener(info);
  }
}

function ensureAddedChannel(): void {
  if (addedChannelPromise !== null) return;
  const handler = (raw: unknown) => {
    void deliverCustomPanelAdded(raw);
  };
  addedChannelPromise = (addedInstallerForTests ?? defaultAddedInstaller)(
    handler,
  ).catch((error: unknown) => {
    // Fail soft: the picker still lists customs after its next refresh;
    // losing the live nudge must not break the registry.
    console.warn("custom-panel-added channel unavailable", error);
    addedChannelPromise = null;
    return () => {};
  });
}

/** Subscribe to owner-added sites (refreshed registry, then notified). */
export function subscribeCustomPanelAdded(listener: AddedListener): () => void {
  ensureAddedChannel();
  addedListeners.add(listener);
  return () => addedListeners.delete(listener);
}

/**
 * Run the native remove-site flow (confirmation dialog, Rust-owned).
 * Returns "removed" when the id no longer resolves afterwards — cancelling
 * the dialog leaves the site in place ("still-present").
 */
export async function removeCustomSite(
  id: string,
): Promise<"removed" | "still-present"> {
  try {
    await invoke("remove_custom_panel", { id });
  } catch (error) {
    toast.error("Couldn't remove the site", {
      description: describeError(error),
    });
    return "still-present";
  }
  await refreshCustomPanels();
  return getWebPanel(id) === null ? "removed" : "still-present";
}

// ── Test seams ──────────────────────────────────────────────────────────

export function setCustomPanelLoaderForTests(
  loader: (() => Promise<unknown>) | null,
): void {
  loaderForTests = loader;
}

/** Swap the custom-panel-added channel for a controllable fake (node
 *  tests capture the handler and drive it directly). */
export function setCustomPanelAddedInstallerForTests(
  installer: AddedEventInstaller | null,
): void {
  addedInstallerForTests = installer;
  addedChannelPromise = null;
}

export function resetWebPanelRegistryForTests(): void {
  phase = "unloaded";
  customs = [];
  readyPromise = null;
  loaderForTests = null;
  addedInstallerForTests = null;
  addedChannelPromise = null;
  addedListeners.clear();
}
