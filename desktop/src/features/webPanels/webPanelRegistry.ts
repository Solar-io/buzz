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

export type AddCustomSiteOutcome =
  | { status: "added"; panel: CustomPanelInfo }
  | { status: "cancelled" };

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

function sanitizeOutcome(raw: unknown): AddCustomSiteOutcome | null {
  if (typeof raw !== "object" || raw === null) return null;
  const outcome = raw as Partial<AddCustomSiteOutcome> & { status?: unknown };
  if (outcome.status === "cancelled") return { status: "cancelled" };
  if (outcome.status === "added") {
    const panel = outcome.panel;
    const info = sanitizeInfos([panel])[0];
    if (info) return { status: "added", panel: info };
  }
  return null;
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
 * Run the native add-site flow (file picker + confirmation, Rust-owned).
 * Returns null when the invoke itself failed (a toast was shown) and
 * `{status: "cancelled"}` when the owner cancelled a dialog — no toast.
 */
export async function addCustomSite(): Promise<AddCustomSiteOutcome | null> {
  try {
    const outcome = sanitizeOutcome(await invoke("add_custom_panel"));
    if (outcome?.status === "added") {
      await refreshCustomPanels();
    }
    return outcome;
  } catch (error) {
    toast.error("Couldn't add the site", { description: describeError(error) });
    return null;
  }
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

export function resetWebPanelRegistryForTests(): void {
  phase = "unloaded";
  customs = [];
  readyPromise = null;
  loaderForTests = null;
}
