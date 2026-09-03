import type {
  CreateManagedAgentInput,
  UpdateManagedAgentInput,
} from "@/shared/api/types";
import type { OwnerAdminCommand } from "./ownerAdminProtocol";

/**
 * Pure command → Tauri-input builders for owner admin commands (kind 24201),
 * extracted from `useOwnerAdminCommands.ts` so the exact forwarding surface is
 * unit-pinnable — Phase 1 documented the "parsed but never forwarded" bug
 * class (avatarUrl/timeouts parsed by the protocol, dropped by the applier),
 * and a hardcoded deep-equal suite here is the guard against it coming back.
 *
 * Clear sentinels are FORWARDED, not filtered: `""` avatar and `0` timeouts
 * ride the wire and the Rust update path owns the `.filter` — clear is
 * expressed exactly once, on the side that persists it.
 */

type CreateCommand = Extract<OwnerAdminCommand, { action: "create" }>;
type UpdateCommand = Extract<OwnerAdminCommand, { action: "update" }>;

function harnessFields(command: {
  harness?: CreateCommand["harness"] | UpdateCommand["harness"];
}) {
  return command.harness
    ? command.harness.kind === "preset"
      ? { acpCommand: command.harness.runtimeId }
      : {
          agentCommand: command.harness.command,
          agentArgs: command.harness.args,
          harnessOverride: true,
        }
    : {};
}

export function createInputFromCommand(
  command: CreateCommand,
): CreateManagedAgentInput {
  return {
    name: command.name,
    systemPrompt: command.systemPrompt,
    ...(command.avatarUrl ? { avatarUrl: command.avatarUrl } : {}),
    ...(command.model ? { model: command.model } : {}),
    ...(command.provider ? { provider: command.provider } : {}),
    ...harnessFields(command),
    ...(command.envVars ? { envVars: command.envVars } : {}),
    ...(command.parallelism ? { parallelism: command.parallelism } : {}),
    ...(command.respondTo ? { respondTo: command.respondTo } : {}),
    ...(command.respondToAllowlist
      ? { respondToAllowlist: command.respondToAllowlist }
      : {}),
    // Timeouts forward whenever parsed, 0 included — Rust applies the
    // >0 filter (create and update share the convention).
    ...(command.idleTimeoutSeconds !== undefined
      ? { idleTimeoutSeconds: command.idleTimeoutSeconds }
      : {}),
    ...(command.maxTurnDurationSeconds !== undefined
      ? { maxTurnDurationSeconds: command.maxTurnDurationSeconds }
      : {}),
    ...(command.spawnAfterCreate !== undefined
      ? { spawnAfterCreate: command.spawnAfterCreate }
      : {}),
    ...(command.startOnAppLaunch !== undefined
      ? { startOnAppLaunch: command.startOnAppLaunch }
      : {}),
  };
}

export function updateInputFromCommand(
  command: UpdateCommand,
): UpdateManagedAgentInput {
  return {
    pubkey: command.pubkey,
    ...(command.name ? { name: command.name } : {}),
    ...(command.systemPrompt ? { systemPrompt: command.systemPrompt } : {}),
    // avatarUrl "" is the CLEAR sentinel — must ride, so the check is
    // !== undefined, not truthiness.
    ...(command.avatarUrl !== undefined
      ? { avatarUrl: command.avatarUrl }
      : {}),
    ...(command.model ? { model: command.model } : {}),
    ...(command.provider ? { provider: command.provider } : {}),
    ...harnessFields(command),
    ...(command.envVars ? { envVars: command.envVars } : {}),
    ...(command.envVarsPatch !== undefined
      ? { envVarsPatch: command.envVarsPatch }
      : {}),
    ...(command.parallelism ? { parallelism: command.parallelism } : {}),
    ...(command.respondTo ? { respondTo: command.respondTo } : {}),
    ...(command.respondToAllowlist
      ? { respondToAllowlist: command.respondToAllowlist }
      : {}),
    // 0 is the CLEAR sentinel for both timeouts — forwarded, filtered in Rust.
    ...(command.idleTimeoutSeconds !== undefined
      ? { idleTimeoutSeconds: command.idleTimeoutSeconds }
      : {}),
    ...(command.maxTurnDurationSeconds !== undefined
      ? { maxTurnDurationSeconds: command.maxTurnDurationSeconds }
      : {}),
    ...(command.startOnAppLaunch !== undefined
      ? { startOnAppLaunch: command.startOnAppLaunch }
      : {}),
  };
}

/** One lifecycle Tauri call, in execution order. */
export interface LifecycleCall {
  op: "start" | "stop";
  pubkey: string;
}

/**
 * Ordered lifecycle calls for the start/stop/restart actions. Restart =
 * stop-then-start: stop of an already-stopped agent is a no-op success
 * (stop.rs falls through to the untracked-pid path), so restart-of-stopped
 * degrades to a plain start — idempotent by construction, zero new Rust.
 */
export function lifecycleCallsFromCommand(
  command:
    | { action: "start"; pubkey: string }
    | { action: "stop"; pubkey: string }
    | { action: "restart"; pubkey: string },
): LifecycleCall[] {
  switch (command.action) {
    case "start":
      return [{ op: "start", pubkey: command.pubkey }];
    case "stop":
      return [{ op: "stop", pubkey: command.pubkey }];
    case "restart":
      return [
        { op: "stop", pubkey: command.pubkey },
        { op: "start", pubkey: command.pubkey },
      ];
  }
}
