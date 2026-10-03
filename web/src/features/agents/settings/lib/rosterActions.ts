import type { AdminCommand } from "../../lib/adminCommands";
import type { RosterRow } from "../../lib/roster";

export type RosterAction = "start" | "stop" | "restart" | "unregister";
export interface RosterReceipt {
  pubkey: string;
  name: string;
  ok: boolean;
  message: string;
}
export type RosterSender = (
  command: AdminCommand,
  summary: string,
  options?: { target?: string },
) => Promise<{ ok: boolean; error?: string }>;

/** No broadcast lifecycle calls: an ambiguous or absent machine is not a target. */
export function rosterActionAllowed(
  row: RosterRow,
  action: RosterAction,
  cleanupKeys: ReadonlySet<string>,
  restartSupported: boolean,
): boolean {
  return action === "unregister"
    ? cleanupKeys.has(row.pubkey) && row.machines.length === 0
    : row.machines.length === 1 && (action !== "restart" || restartSupported);
}

/** Per-agent atomic actions, three in flight; a refusal never rolls back its peers. */
export async function runRosterActions(
  rows: readonly RosterRow[],
  action: RosterAction,
  send: RosterSender,
): Promise<RosterReceipt[]> {
  const unique = [...new Map(rows.map((row) => [row.pubkey, row])).values()];
  const receipts: RosterReceipt[] = new Array(unique.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(3, unique.length) }, async () => {
      while (cursor < unique.length) {
        const index = cursor++;
        const row = unique[index];
        try {
          if (action !== "unregister" && row.machines.length !== 1) {
            throw new Error("Needs one claiming desktop.");
          }
          const ack = await send(
            { action, request: { pubkey: row.pubkey } },
            `${action[0].toUpperCase()}${action.slice(1)} ${row.name}`,
            action === "unregister" ? {} : { target: row.machines[0] },
          );
          receipts[index] = {
            pubkey: row.pubkey,
            name: row.name,
            ok: ack.ok,
            message: ack.ok
              ? "Applied on Buzz Desktop"
              : (ack.error ?? "The desktop refused the command."),
          };
        } catch (error) {
          receipts[index] = {
            pubkey: row.pubkey,
            name: row.name,
            ok: false,
            message:
              error instanceof Error
                ? error.message
                : "Could not send the command.",
          };
        }
      }
    }),
  );
  return receipts;
}
