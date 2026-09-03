import type { AdminCommand } from "./adminCommands.ts";
import { targetForAgent } from "./roster.ts";
import type { AgentSnapshotView } from "./snapshotManifest.ts";

/**
 * Config-only snapshot → 24201 create command (Phase 3 §0.1 / §2.1 A9).
 *
 * HONESTY GUARD (the load-bearing rule): the existing 24201 create action can
 * carry the snapshot definition quad but NOT memory entries and NOT a name
 * pool. Rather than silently dropping them, this builder REFUSES —
 * `{ unavailable }` — whenever either is present, and the preview shows the
 * desktop-only note instead of an Add button. The structural guard is pinned
 * by test; removing it must fail the suite.
 *
 * Behavioral mapping mirrors the desktop import's Clear default
 * (import.rs resolve_snapshot_import_behavior): `respondTo` is ALWAYS
 * owner-only — foreign allowlists come from the sender's relay and are
 * meaningless here — `spawnAfterCreate` is false (review-then-start, never an
 * auto-started agent), and `startOnAppLaunch` is false.
 */

export type SnapshotCreateResult =
  | {
      command: Extract<AdminCommand, { action: "create" }>;
      /** Machine targeting: one desktop → silent target; else broadcast. */
      target?: string;
      /** Divergences from the reviewed manifest the preview must disclose. */
      notes: string[];
    }
  | { unavailable: string }
  | { error: string };

export function buildSnapshotCreate(
  view: AgentSnapshotView,
  machines: readonly string[],
  harnessIds: readonly string[] = [],
): SnapshotCreateResult {
  if (view.memoryEntryCount > 0) {
    return {
      unavailable:
        `This snapshot includes ${view.memoryEntryCount} memory ` +
        `entr${view.memoryEntryCount === 1 ? "y" : "ies"}. ` +
        "Import in the Buzz desktop app to include memory.",
    };
  }
  if (view.definition.namePool.length > 0) {
    return {
      unavailable:
        "This snapshot includes a name pool. Import in the Buzz desktop app to include it.",
    };
  }
  const prompt = view.definition.systemPrompt?.trim() ?? "";
  if (!prompt) {
    return {
      unavailable:
        "This snapshot has no system prompt. Import in the Buzz desktop app.",
    };
  }
  const name = view.displayName.trim();
  if (!name) {
    return { error: "A name is required." };
  }

  const notes: string[] = [];
  if (view.definition.respondToAllowlist.length > 0) {
    notes.push(
      `Web import always starts owner-only — the source allowlist (${view.definition.respondToAllowlist.length} entr${view.definition.respondToAllowlist.length === 1 ? "y" : "ies"}) is not copied.`,
    );
  }

  const definition = view.definition;
  const avatarUrl =
    view.avatarUrl && /^https?:\/\//i.test(view.avatarUrl)
      ? view.avatarUrl.trim()
      : "";
  if (view.avatarDataUrl && !avatarUrl) {
    notes.push(
      "The inline avatar cannot be carried by a web import — the new agent starts with the default avatar.",
    );
  }

  let harness: { kind: "preset"; runtimeId: string } | undefined;
  if (definition.runtime && harnessIds.includes(definition.runtime)) {
    harness = { kind: "preset", runtimeId: definition.runtime };
  } else if (definition.runtime) {
    notes.push(
      `The snapshot's runtime ("${definition.runtime}") is not a harness on your desktops — the desktop default harness applies.`,
    );
  }

  return {
    command: {
      action: "create",
      request: {
        name,
        systemPrompt: prompt,
        ...(avatarUrl ? { avatarUrl } : {}),
        ...(definition.model?.trim() ? { model: definition.model.trim() } : {}),
        ...(definition.provider?.trim()
          ? { provider: definition.provider.trim() }
          : {}),
        ...(harness ? { harness } : {}),
        ...(definition.parallelism && definition.parallelism > 0
          ? { parallelism: definition.parallelism }
          : {}),
        ...(definition.idleTimeoutSeconds && definition.idleTimeoutSeconds > 0
          ? { idleTimeoutSeconds: definition.idleTimeoutSeconds }
          : {}),
        ...(definition.maxTurnDurationSeconds &&
        definition.maxTurnDurationSeconds > 0
          ? { maxTurnDurationSeconds: definition.maxTurnDurationSeconds }
          : {}),
        respondTo: "owner-only",
        spawnAfterCreate: false,
        startOnAppLaunch: false,
      },
    },
    ...targetForAgent([...machines]),
    notes,
  };
}
