import type { AdminAckEnvelope } from "../../../lib/adminCommands";
import type { SettingsAck } from "../../lib/settingsSave";

/** Watch the existing owner's ack map, including an ack that beat relay OK. */
export async function awaitSettingsAck(
  requestId: string,
  readAcks: () => ReadonlyMap<string, AdminAckEnvelope>,
): Promise<SettingsAck> {
  const started = Date.now();
  while (Date.now() - started < 30_100) {
    const ack = readAcks().get(requestId);
    if (ack) return { ok: ack.ok, error: ack.error };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // W7's 30 s race already marked the edit uncertain; stop polling afterwards.
  return {
    ok: false,
    error:
      "No answer from Buzz Desktop — it may still apply. Check status after reload.",
  };
}
