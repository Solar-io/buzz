/**
 * Owner admin-command protocol (kind 24201) — desktop-side narrow parser.
 * Canonical shape + web sender: `web/src/features/agents/lib/adminCommands.ts`
 * (kept as a deliberate copy; the two packages do not share source).
 */

export const AGENT_ADMIN_COMMAND_TYPE = "agent_admin_command";

export type HarnessSelection =
  | { kind: "preset"; runtimeId: string }
  | { kind: "custom"; command: string; args: string[] };

export type OwnerAdminCommand = {
  /**
   * Machine targeting (hostname, e.g. "crichton.local"): when present and not
   * this machine's hostname, the command is for another desktop — ignore it
   * silently (no ack; the targeted machine acks). Absent = legacy broadcast.
   */
  target?: string;
} & (
  | {
      action: "create";
      requestId: string;
      name: string;
      systemPrompt: string;
      avatarUrl?: string;
      model?: string;
      provider?: string;
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
  | {
      action: "update";
      requestId: string;
      pubkey: string;
      name?: string;
      systemPrompt?: string;
      avatarUrl?: string;
      model?: string;
      provider?: string;
      harness?: HarnessSelection;
      envVars?: Record<string, string>;
      /**
       * Merge-patch for the stored env map, applied AFTER any `envVars`
       * replace in the same command: string = set/overwrite the key, null =
       * delete it (deleting a missing key is a no-op). The backend validates
       * the FINAL merged map before saving.
       */
      envVarsPatch?: Record<string, string | null>;
      parallelism?: number;
      respondTo?: "owner-only" | "anyone" | "allowlist";
      respondToAllowlist?: string[];
      idleTimeoutSeconds?: number;
      maxTurnDurationSeconds?: number;
      startOnAppLaunch?: boolean;
    }
  | {
      action: "delete";
      requestId: string;
      pubkey: string;
      forceRemoteDelete?: boolean;
    }
  | { action: "unregister"; requestId: string; pubkey: string }
  | { action: "start"; requestId: string; pubkey: string }
  | { action: "stop"; requestId: string; pubkey: string }
  | { action: "restart"; requestId: string; pubkey: string }
);

const PUBKEY_RE = /^[0-9a-f]{64}$/;

function isText(value: unknown): value is string {
  return typeof value === "string";
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

/**
 * envVarsPatch parse: an object whose every value is a string (set) or null
 * (delete). ANY other value anywhere → undefined (field dropped, command
 * still parses) — same stance as `optionalStringRecord`, so a malformed patch
 * degrades to "no patch" rather than killing the whole command.
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

function optionalPubkeyList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const list = value.filter(isText);
  return list.length === value.length ? list : undefined;
}

function parseHarness(value: unknown): HarnessSelection | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
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
  return undefined;
}

function optionalRespondTo(
  value: unknown,
): "owner-only" | "anyone" | "allowlist" | undefined {
  return value === "owner-only" || value === "anyone" || value === "allowlist"
    ? value
    : undefined;
}

/**
 * Machine-targeting gate: should THIS desktop apply the command?
 *
 * - No `target` → legacy broadcast, every desktop applies it.
 * - `target` matching our hostname → ours to apply.
 * - `target` for another machine → not ours, drop silently (no ack — the
 *   targeted machine acks).
 * - `target` present but our hostname unknown ("" — lookup failed) → fail
 *   closed: never apply a targeted command we cannot prove is ours.
 */
export function commandTargetsThisMachine(
  command: Pick<OwnerAdminCommand, "target">,
  hostname: string,
): boolean {
  if (!command.target) {
    return true;
  }
  const normalized = command.target.trim().toLowerCase();
  return (
    hostname.trim().length > 0 && hostname.trim().toLowerCase() === normalized
  );
}

/**
 * Narrow parse of a decrypted command payload. Anything outside the contract
 * is dropped (null) — same discipline as parseAgentManagementRequest.
 */
export function parseOwnerAdminCommand(
  value: unknown,
): OwnerAdminCommand | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const envelope = value as Record<string, unknown>;
  if (envelope.type !== AGENT_ADMIN_COMMAND_TYPE) {
    return null;
  }
  if (!isText(envelope.action) || !isText(envelope.requestId)) {
    return null;
  }
  const request =
    typeof envelope.request === "object" && envelope.request !== null
      ? (envelope.request as Record<string, unknown>)
      : null;
  if (!request) {
    return null;
  }
  const base = {
    requestId: envelope.requestId,
    // Optional machine targeting; a non-string target is dropped and the
    // command still parses (legacy senders never set it).
    ...(optionalString(envelope.target)
      ? { target: optionalString(envelope.target) }
      : {}),
  };

  switch (envelope.action) {
    case "create":
      if (!isText(request.name) || !isText(request.systemPrompt)) {
        return null;
      }
      return {
        ...base,
        action: "create",
        name: request.name,
        systemPrompt: request.systemPrompt,
        avatarUrl: optionalString(request.avatarUrl),
        model: optionalString(request.model),
        provider: optionalString(request.provider),
        harness: parseHarness(request.harness),
        envVars: optionalStringRecord(request.envVars),
        parallelism: optionalNumber(request.parallelism),
        respondTo: optionalRespondTo(request.respondTo) ?? "owner-only",
        respondToAllowlist: optionalPubkeyList(request.respondToAllowlist),
        idleTimeoutSeconds: optionalNumber(request.idleTimeoutSeconds),
        maxTurnDurationSeconds: optionalNumber(request.maxTurnDurationSeconds),
        spawnAfterCreate:
          typeof request.spawnAfterCreate === "boolean"
            ? request.spawnAfterCreate
            : undefined,
        startOnAppLaunch:
          typeof request.startOnAppLaunch === "boolean"
            ? request.startOnAppLaunch
            : undefined,
      };
    case "update":
      if (!isText(request.pubkey) || !PUBKEY_RE.test(request.pubkey)) {
        return null;
      }
      return {
        ...base,
        action: "update",
        pubkey: request.pubkey,
        name: optionalString(request.name),
        systemPrompt: optionalString(request.systemPrompt),
        avatarUrl: optionalString(request.avatarUrl),
        model: optionalString(request.model),
        provider: optionalString(request.provider),
        harness: parseHarness(request.harness),
        envVars: optionalStringRecord(request.envVars),
        envVarsPatch: optionalEnvPatch(request.envVarsPatch),
        parallelism: optionalNumber(request.parallelism),
        respondTo: optionalRespondTo(request.respondTo),
        respondToAllowlist: optionalPubkeyList(request.respondToAllowlist),
        idleTimeoutSeconds: optionalNumber(request.idleTimeoutSeconds),
        maxTurnDurationSeconds: optionalNumber(request.maxTurnDurationSeconds),
        startOnAppLaunch:
          typeof request.startOnAppLaunch === "boolean"
            ? request.startOnAppLaunch
            : undefined,
      };
    case "delete":
      if (!isText(request.pubkey) || !PUBKEY_RE.test(request.pubkey)) {
        return null;
      }
      return {
        ...base,
        action: "delete",
        pubkey: request.pubkey,
        forceRemoteDelete:
          typeof request.forceRemoteDelete === "boolean"
            ? request.forceRemoteDelete
            : undefined,
      };
    case "start":
    case "stop":
    case "restart":
    case "unregister":
      if (!isText(request.pubkey) || !PUBKEY_RE.test(request.pubkey)) {
        return null;
      }
      return { ...base, action: envelope.action, pubkey: request.pubkey };
    default:
      return null;
  }
}
