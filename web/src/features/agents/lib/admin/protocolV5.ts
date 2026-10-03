/** P0 read-only probe. Future command families live beside this file. */
export interface PingCommand {
  action: "ping";
  request: Record<string, never>;
}

export interface AdminSendOptions {
  target?: string;
  requires?: readonly string[];
}

export type AdminAckCode =
  | "unsupported"
  | "stale"
  | "conflict"
  | "invalid"
  | "failed"
  | "too_large"
  | "started";

/** Keep acks additive; unknown codes stay readable for newer desktops. */
export function ackExtensions(raw: Record<string, unknown>): {
  code?: string;
  result?: Record<string, unknown>;
} {
  return {
    ...(typeof raw.code === "string" ? { code: raw.code } : {}),
    ...(typeof raw.result === "object" &&
    raw.result !== null &&
    !Array.isArray(raw.result)
      ? { result: raw.result as Record<string, unknown> }
      : {}),
  };
}
