import type { AdminCommand } from "./adminCommands.ts";
import type { DesktopCatalog } from "./desktopCatalog.ts";
import type { CatalogPublication } from "./personaCatalog.ts";
import { targetForAgent } from "./roster.ts";

/**
 * Catalog publication → 24201 create command (Phase 3 §2.2 B3) — the web's
 * "Add agent from catalog", riding the EXISTING owner-admin create action.
 * Copy semantics, exactly like the desktop's own catalog add
 * (usePersonaActions: the added persona is a local COPY with catalogSource
 * provenance, never a live link): the new agent gets a fresh identity and
 * nothing about the source publication is subscribed or followed.
 *
 * Access mapping mirrors the desktop's foreign-allowlist policy: `respondTo`
 * is ALWAYS owner-only. A publisher's "anyone"/"allowlist" posture describes
 * THEIR deployment, not yours — the divergence is disclosed in `notes` when
 * the publication was "anyone". `spawnAfterCreate` false (review-then-start;
 * an install must never auto-launch), `startOnAppLaunch` false.
 *
 * Field policy: model/provider ride only when non-blank; the harness preset
 * rides only when the publication's runtime matches a harness id on one of
 * the owner's kind-30180 catalogs (foreign runtime ids can name anything);
 * parallelism rides when the projection kept it (already 1..=32); avatarUrl
 * rides only when http(s) — inline data: avatars cannot be carried by the
 * create action (the desktop's import path re-hosts those pixels itself), so
 * they are dropped WITH a note, never silently.
 */

export type CatalogCreateResult =
  | {
      command: Extract<AdminCommand, { action: "create" }>;
      /** Machine targeting: one desktop → silent target; else broadcast. */
      target?: string;
      /** Divergences from the reviewed publication the detail pane discloses. */
      notes: string[];
    }
  | { error: string };

export function buildCatalogCreate(
  publication: CatalogPublication,
  catalogs: readonly DesktopCatalog[],
): CatalogCreateResult {
  const { agent } = publication;
  const name = agent.displayName.trim();
  if (!name) {
    return { error: "A name is required." };
  }
  const systemPrompt = agent.systemPrompt.trim();
  if (!systemPrompt) {
    return {
      error:
        "This publication has no agent instructions, so there is nothing to install.",
    };
  }

  const notes: string[] = [];
  if (agent.respondTo === "anyone") {
    notes.push(
      "The publisher allows anyone to use this agent. Your copy starts owner-only — change who can use it after installing.",
    );
  }

  const avatarUrl =
    agent.avatarUrl && /^https?:\/\//i.test(agent.avatarUrl)
      ? agent.avatarUrl.trim()
      : "";
  if (agent.avatarUrl && !avatarUrl) {
    notes.push(
      "The publication's inline avatar cannot be carried by an install — the new agent starts with the default avatar.",
    );
  }

  const harnessIds = new Set(
    catalogs.flatMap((catalog) => catalog.harnesses.map((h) => h.id)),
  );
  let harness: { kind: "preset"; runtimeId: string } | undefined;
  if (agent.runtime && harnessIds.has(agent.runtime)) {
    harness = { kind: "preset", runtimeId: agent.runtime };
  } else if (agent.runtime) {
    notes.push(
      `The publisher's runtime ("${agent.runtime}") is not a harness on your desktops — the desktop default harness applies.`,
    );
  }

  return {
    command: {
      action: "create",
      request: {
        name,
        systemPrompt,
        ...(avatarUrl ? { avatarUrl } : {}),
        ...(agent.model?.trim() ? { model: agent.model.trim() } : {}),
        ...(agent.provider?.trim() ? { provider: agent.provider.trim() } : {}),
        ...(harness ? { harness } : {}),
        ...(agent.parallelism ? { parallelism: agent.parallelism } : {}),
        respondTo: "owner-only",
        spawnAfterCreate: false,
        startOnAppLaunch: false,
      },
    },
    ...targetForAgent(catalogs.map((catalog) => catalog.machine)),
    notes,
  };
}
