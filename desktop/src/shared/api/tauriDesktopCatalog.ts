import type { RelayEvent } from "@/shared/api/types";
import { invokeTauri } from "./tauri";
import { relayClient } from "./relayClient";
import { DESKTOP_CATALOG_KIND } from "@/features/agents/desktopCatalogContent";

/**
 * Kind-30180 desktop-catalog publish primitives — same sign+publish pattern
 * as `tauriOwnerAdmin.ts`'s ack publisher: build content → sign via the
 * existing `sign_event` command → relayClient publish. Nothing new Rust-side.
 */

/**
 * Seal an owner-only catalog block (e.g. the Claude pools payload) with the
 * SAME primitive the owner admin channel uses for acks —
 * `nip44_encrypt_to_self` — so only the owner key can read it. No new crypto.
 */
export async function sealCatalogBlockToOwner(
  plaintext: string,
): Promise<string> {
  return invokeTauri<string>("nip44_encrypt_to_self", { plaintext });
}

export async function buildDesktopCatalogEvent(
  content: string,
  machine: string,
): Promise<RelayEvent> {
  const eventJson = await invokeTauri<string>("sign_event", {
    kind: DESKTOP_CATALOG_KIND,
    content,
    createdAt: null,
    tags: [["d", machine]],
  });
  return JSON.parse(eventJson) as RelayEvent;
}

export async function publishDesktopCatalog(
  content: string,
  machine: string,
): Promise<void> {
  await relayClient.preconnect();
  const event = await buildDesktopCatalogEvent(content, machine);
  await relayClient.publishEvent(
    event,
    "Timed out while sending the desktop catalog.",
    "Failed to send the desktop catalog.",
  );
}
