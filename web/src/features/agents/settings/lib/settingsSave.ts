import type { SettingsCommandPlan } from "./settingsDraft";

/** Final desktop apply verdict, including verbatim refusal text. */
export interface SettingsAck {
  timedOut?: boolean;
  ok: boolean;
  error?: string;
  message?: string;
}
/** Per-agent result, preserving timeout uncertainty separately from refusal. */
export interface SettingsSaveResult {
  plan: SettingsCommandPlan;
  ack: SettingsAck;
  timedOut: boolean;
}

/** This boundary must resolve the desktop acknowledgement, not relay acceptance. */
export type SendSettingsCommand = (
  plan: SettingsCommandPlan,
) => Promise<SettingsAck>;

/** Three concurrent per-agent writes; no rollback of acknowledged successes. */
export async function saveSettingsCommands(
  plans: readonly SettingsCommandPlan[],
  send: SendSettingsCommand,
  timeoutMs = 30_000,
): Promise<SettingsSaveResult[]> {
  const results: SettingsSaveResult[] = new Array(plans.length);
  let cursor = 0;
  async function worker() {
    while (cursor < plans.length) {
      const index = cursor++;
      const plan = plans[index];
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      try {
        const ack = await Promise.race([
          Promise.resolve().then(() => send(plan)),
          new Promise<SettingsAck>((resolve) => {
            timer = setTimeout(() => {
              timedOut = true;
              resolve({
                ok: false,
                error: `No answer from ${plan.machine} — it may still apply. Check status after reload.`,
              });
            }, timeoutMs);
          }),
        ]);
        results[index] = { plan, ack, timedOut };
      } catch (error) {
        results[index] = {
          plan,
          ack: {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          },
          timedOut: false,
        };
      } finally {
        clearTimeout(timer);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, plans.length) }, worker));
  return results;
}
