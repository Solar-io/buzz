// Temporary renderer profiling harness (never merges) — IPC invoke probe.
//
// The interception logic lives here (not harness.ts) so it can be unit-tested
// without harness.ts's module-load Tauri/store imports, matching drift.ts.

/** A command outstanding >10s is logged with its age — the deadlock detector. */
export const PENDING_INVOKE_MS = 10_000;
/** Watchdog scan cadence. */
export const PENDING_SCAN_MS = 5_000;

export type InvokeFn = (
  cmd: string,
  args?: unknown,
  opts?: unknown,
) => Promise<unknown>;

export type IpcInternals = { invoke: InvokeFn };

export type PendingInvoke = { cmd: string; startedAt: number };

/**
 * Wrap `__TAURI_INTERNALS__.invoke` to record each call's duration/outcome,
 * tracking outstanding calls in `pending` for the watchdog. Returns `false`
 * when no invoke bridge is present (the harness stays passive).
 *
 * The wrapper is installed as a **data property** via `Object.defineProperty`,
 * never `internals.invoke = wrapper`. The terminal E2E backend defines `invoke`
 * as an accessor whose getter returns a dispatcher that falls back to a closure
 * variable and whose setter *reassigns that fallback*; a plain assignment would
 * therefore route the bridge's fallback back into this wrapper and overflow the
 * stack on the first non-terminal invoke. Reading the getter once (to bind the
 * current implementation) and redefining `invoke` as a value preserves any
 * accessor- or reassignment-backed bridge without looping into ourselves.
 */
export function installInvokeProbe(
  internals: IpcInternals | undefined,
  pending: Map<number, PendingInvoke>,
  record: (cmd: string, dur: number, ok: boolean) => void,
  now: () => number = () => performance.now(),
): boolean {
  if (!internals || typeof internals.invoke !== "function") {
    return false;
  }
  const original = internals.invoke.bind(internals);
  let seq = 0;

  const wrapper: InvokeFn = (cmd, args, opts) => {
    const id = seq++;
    const startedAt = now();
    pending.set(id, { cmd, startedAt });
    const settle = (ok: boolean) => {
      pending.delete(id);
      record(cmd, now() - startedAt, ok);
    };
    return original(cmd, args, opts).then(
      (value) => {
        settle(true);
        return value;
      },
      (error) => {
        settle(false);
        throw error;
      },
    );
  };

  Object.defineProperty(internals, "invoke", {
    configurable: true,
    writable: true,
    value: wrapper,
  });
  return true;
}
