/**
 * Owner admin-command protocol (kinds 24201/24202) — the web → desktop
 * remote-management channel. Pure shapes + validation only (import-free so
 * the node runner can load this file); sealing/sending lives in
 * adminCommandsSend.ts.
 *
 * The `request` payloads mirror the desktop's createManagedAgent /
 * updateManagedAgent / deleteManagedAgent input subset so the desktop
 * applies them through its own save paths unchanged ("same as what is
 * available in the desktop buzz" — Sam, 2026-09-01).
 */

export const AGENT_ADMIN_COMMAND_TYPE = "agent_admin_command";
export const AGENT_ADMIN_ACK_TYPE = "agent_admin_ack";

export const ADMIN_COMMAND_KIND = 24201;
export const ADMIN_ACK_KIND = 24202;

/** Harness choice: a preset runtime id, or a custom command (+ args). */
export interface HarnessPreset {
  kind: "preset";
  runtimeId: string;
}

export interface HarnessCustom {
  kind: "custom";
  /** The command line to launch the harness. */
  command: string;
  args: string[];
}

export type HarnessSelection = HarnessPreset | HarnessCustom;

export interface CreateAgentRequest {
  name: string;
  systemPrompt: string;
  avatarUrl?: string;
  model?: string;
  provider?: string;
  /** Absent → the desktop's default harness applies. */
  harness?: HarnessSelection;
  envVars?: Record<string, string>;
  parallelism?: number;
  respondTo?: "owner-only" | "anyone" | "allowlist";
  respondToAllowlist?: string[];
  idleTimeoutSeconds?: number;
  maxTurnDurationSeconds?: number;
  spawnAfterCreate?: boolean;
  startOnAppLaunch?: boolean;
}

export interface UpdateAgentRequest {
  /** Target agent pubkey (the 30177 d tag). */
  pubkey: string;
  name?: string;
  systemPrompt?: string;
  /** Absent = keep. Non-empty = set. `""` = clear to the harness default. */
  avatarUrl?: string;
  model?: string;
  provider?: string;
  harness?: HarnessSelection;
  envVars?: Record<string, string>;
  /**
   * Merge-patch for the stored env map, applied AFTER any `envVars` replace
   * in the same command: string = set/overwrite the key, null = delete it
   * (deleting a missing key is a no-op). The web builder never sends both —
   * a dirty env table folds the effort key into its replace instead.
   */
  envVarsPatch?: Record<string, string | null>;
  parallelism?: number;
  respondTo?: "owner-only" | "anyone" | "allowlist";
  respondToAllowlist?: string[];
  /** Absent = keep. `>0` = set. `0` = clear to the harness default (320 s). */
  idleTimeoutSeconds?: number;
  /** Absent = keep. `>0` = set. `0` = clear to the harness default (3600 s). */
  maxTurnDurationSeconds?: number;
  startOnAppLaunch?: boolean;
}

export interface DeleteAgentRequest {
  pubkey: string;
  /** Tombstone the 30177 even if the local record is already gone. */
  forceRemoteDelete?: boolean;
}

export interface StartAgentRequest {
  pubkey: string;
}

export interface StopAgentRequest {
  pubkey: string;
}

export interface RestartAgentRequest {
  pubkey: string;
}

export type AdminCommand =
  | { action: "create"; request: CreateAgentRequest }
  | { action: "update"; request: UpdateAgentRequest }
  | { action: "delete"; request: DeleteAgentRequest }
  | { action: "start"; request: StartAgentRequest }
  | { action: "stop"; request: StopAgentRequest }
  | { action: "restart"; request: RestartAgentRequest };

/** Envelope carried inside the NIP-44-sealed kind-24201 content. */
export interface AdminCommandEnvelope {
  type: typeof AGENT_ADMIN_COMMAND_TYPE;
  action: AdminCommand["action"];
  requestId: string;
  issuedAt: string;
  /**
   * Machine targeting (hostname, e.g. "crichton.local"): only the desktop
   * whose hostname matches applies the command; every other desktop ignores
   * it silently (no ack — the targeted machine acks). Absent = legacy
   * broadcast: every desktop applies it. Sent whenever the web knows at
   * least one desktop catalog, so a two-desktop owner never mints the same
   * agent twice.
   */
  target?: string;
  request: unknown;
}

/** Envelope carried inside the sealed kind-24202 content. */
export interface AdminAckEnvelope {
  type: typeof AGENT_ADMIN_ACK_TYPE;
  requestId: string;
  ok: boolean;
  error?: string;
  /** Agent pubkey for create results — lets the UI jump to the new agent. */
  agentPubkey?: string;
}

const PUBKEY_RE = /^[0-9a-f]{64}$/;

function isText(value: unknown): value is string {
  return typeof value === "string";
}

function parseHarness(value: unknown): HarnessSelection | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const harness = value as Record<string, unknown>;
  if (harness.kind === "preset" && isText(harness.runtimeId)) {
    return { kind: "preset", runtimeId: harness.runtimeId };
  }
  if (
    harness.kind === "custom" &&
    isText(harness.command) &&
    Array.isArray(harness.args) &&
    harness.args.every(isText)
  ) {
    return { kind: "custom", command: harness.command, args: harness.args };
  }
  return null;
}

function optionalString(value: unknown): string | undefined {
  return isText(value) ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function optionalStringRecord(
  value: unknown,
): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isText(entry)) {
      return undefined;
    }
    out[key] = entry;
  }
  return out;
}

function optionalPubkeyList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const list = value.filter(isText);
  return list.length === value.length ? list : undefined;
}

/**
 * envVarsPatch parse (mirror of the desktop's `optionalEnvPatch`): an object
 * whose every value is a string (set) or null (delete). Any other value
 * anywhere — or an array — drops the whole field; the command still parses.
 */
function optionalEnvPatch(
  value: unknown,
): Record<string, string | null> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const out: Record<string, string | null> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === null) {
      out[key] = null;
      continue;
    }
    if (!isText(entry)) {
      return undefined;
    }
    out[key] = entry;
  }
  return out;
}

/**
 * Narrow parse of an untrusted command envelope. Mirrors the desktop's
 * parseAgentManagementRequest discipline: only the deliberately narrow
 * contract is accepted; anything else is dropped (null).
 */
export function parseAdminCommand(
  value: unknown,
): (AdminCommandEnvelope & { command: AdminCommand; target?: string }) | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const envelope = value as Record<string, unknown>;
  if (envelope.type !== AGENT_ADMIN_COMMAND_TYPE) {
    return null;
  }
  if (
    !isText(envelope.action) ||
    !isText(envelope.requestId) ||
    !isText(envelope.issuedAt)
  ) {
    return null;
  }
  const issuedAt = envelope.issuedAt;
  const request =
    typeof envelope.request === "object" && envelope.request !== null
      ? (envelope.request as Record<string, unknown>)
      : null;
  if (!request) {
    return null;
  }

  let command: AdminCommand | null = null;
  switch (envelope.action) {
    case "create":
      if (!isText(request.name) || !isText(request.systemPrompt)) {
        return null;
      }
      command = {
        action: "create",
        request: {
          name: request.name,
          systemPrompt: request.systemPrompt,
          avatarUrl: optionalString(request.avatarUrl),
          model: optionalString(request.model),
          provider: optionalString(request.provider),
          harness:
            request.harness === undefined
              ? undefined
              : (parseHarness(request.harness) ?? undefined),
          envVars: optionalStringRecord(request.envVars),
          parallelism: optionalNumber(request.parallelism),
          respondTo:
            request.respondTo === "anyone" || request.respondTo === "allowlist"
              ? request.respondTo
              : "owner-only",
          respondToAllowlist: optionalPubkeyList(request.respondToAllowlist),
          idleTimeoutSeconds: optionalNumber(request.idleTimeoutSeconds),
          maxTurnDurationSeconds: optionalNumber(
            request.maxTurnDurationSeconds,
          ),
          spawnAfterCreate:
            typeof request.spawnAfterCreate === "boolean"
              ? request.spawnAfterCreate
              : undefined,
          startOnAppLaunch:
            typeof request.startOnAppLaunch === "boolean"
              ? request.startOnAppLaunch
              : undefined,
        },
      };
      break;
    case "update":
      if (!isText(request.pubkey) || !PUBKEY_RE.test(request.pubkey)) {
        return null;
      }
      command = {
        action: "update",
        request: {
          pubkey: request.pubkey,
          name: optionalString(request.name),
          systemPrompt: optionalString(request.systemPrompt),
          avatarUrl: optionalString(request.avatarUrl),
          model: optionalString(request.model),
          provider: optionalString(request.provider),
          harness:
            request.harness === undefined
              ? undefined
              : (parseHarness(request.harness) ?? undefined),
          envVars: optionalStringRecord(request.envVars),
          envVarsPatch: optionalEnvPatch(request.envVarsPatch),
          parallelism: optionalNumber(request.parallelism),
          respondTo:
            request.respondTo === "owner-only" ||
            request.respondTo === "anyone" ||
            request.respondTo === "allowlist"
              ? request.respondTo
              : undefined,
          respondToAllowlist: optionalPubkeyList(request.respondToAllowlist),
          idleTimeoutSeconds: optionalNumber(request.idleTimeoutSeconds),
          maxTurnDurationSeconds: optionalNumber(
            request.maxTurnDurationSeconds,
          ),
          startOnAppLaunch:
            typeof request.startOnAppLaunch === "boolean"
              ? request.startOnAppLaunch
              : undefined,
        },
      };
      break;
    case "delete":
      if (!isText(request.pubkey) || !PUBKEY_RE.test(request.pubkey)) {
        return null;
      }
      command = {
        action: "delete",
        request: {
          pubkey: request.pubkey,
          forceRemoteDelete:
            typeof request.forceRemoteDelete === "boolean"
              ? request.forceRemoteDelete
              : undefined,
        },
      };
      break;
    case "start":
    case "stop":
    case "restart":
      if (!isText(request.pubkey) || !PUBKEY_RE.test(request.pubkey)) {
        return null;
      }
      command = {
        action: envelope.action,
        request: { pubkey: request.pubkey },
      };
      break;
    default:
      return null;
  }

  if (!command) {
    return null;
  }
  // Optional machine targeting: a non-string target is dropped, the command
  // still parses (legacy senders never set it).
  const target = optionalString(envelope.target);
  return {
    type: AGENT_ADMIN_COMMAND_TYPE,
    action: envelope.action,
    requestId: envelope.requestId,
    issuedAt: issuedAt,
    ...(target ? { target } : {}),
    request: envelope.request,
    command,
  };
}

/** Narrow parse of an ack envelope. */
export function parseAdminAck(value: unknown): AdminAckEnvelope | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const envelope = value as Record<string, unknown>;
  if (envelope.type !== AGENT_ADMIN_ACK_TYPE) {
    return null;
  }
  if (!isText(envelope.requestId) || typeof envelope.ok !== "boolean") {
    return null;
  }
  return {
    type: AGENT_ADMIN_ACK_TYPE,
    requestId: envelope.requestId,
    ok: envelope.ok,
    error: optionalString(envelope.error),
    agentPubkey:
      isText(envelope.agentPubkey) && PUBKEY_RE.test(envelope.agentPubkey)
        ? envelope.agentPubkey
        : undefined,
  };
}

/** Build a create command's harness from form state (pure convenience). */
export function harnessFromSelection(
  presetId: string | null,
  customCommand: string,
  customArgs: string,
): HarnessSelection | null {
  const trimmedCommand = customCommand.trim();
  if (presetId) {
    return { kind: "preset", runtimeId: presetId };
  }
  if (trimmedCommand) {
    return {
      kind: "custom",
      command: trimmedCommand,
      args: customArgs
        .split(/\s+/)
        .map((arg) => arg.trim())
        .filter(Boolean),
    };
  }
  return null;
}
