import type { OwnerAdminAck } from "@/shared/api/ownerAdminAck";
import { OWNER_ADMIN_CAPS } from "./ownerAdminCaps";
import { DESKTOP_CATALOG_VERSION } from "./desktopCatalogContent";
import type { OwnerAdminCommand } from "./ownerAdminProtocol";

/** Apply only after capability and freshness checks; ping never touches agents. */
export async function executeOwnerAdminCommand(
  command: OwnerAdminCommand,
  apply: (command: OwnerAdminCommand) => Promise<string | null>,
  machine: string,
  now = Date.now(),
): Promise<OwnerAdminAck> {
  const base = { requestId: command.requestId };
  const missing = (command.requires ?? []).filter(
    (cap) => !(OWNER_ADMIN_CAPS as readonly string[]).includes(cap),
  );
  if (missing.length > 0) {
    return {
      ...base,
      ok: false,
      code: "unsupported",
      error: `Update Buzz Desktop to use: ${missing.join(", ")}.`,
    };
  }
  if (command.action === "ping") {
    return {
      ...base,
      ok: true,
      result: {
        catalogVersion: DESKTOP_CATALOG_VERSION,
        caps: [...OWNER_ADMIN_CAPS],
        machine,
        now: new Date(now).toISOString(),
      },
    };
  }
  const issuedAt = command.issuedAt ? Date.parse(command.issuedAt) : Number.NaN;
  if (
    !Number.isFinite(issuedAt) ||
    now - issuedAt > 300_000 ||
    issuedAt - now > 60_000
  ) {
    return {
      ...base,
      ok: false,
      code: "stale",
      error: "This command expired. Reload and try again.",
    };
  }
  try {
    const agentPubkey = await apply(command);
    return { ...base, ok: true, ...(agentPubkey ? { agentPubkey } : {}) };
  } catch (error) {
    return {
      ...base,
      ok: false,
      code: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
