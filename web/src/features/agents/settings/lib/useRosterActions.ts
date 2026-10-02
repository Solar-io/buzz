import { useEffect, useRef, useState } from "react";
import type { useAdminCommands } from "../../ui/AgentAdminPanel";
import type { RosterRow } from "../../lib/roster";
import {
  runRosterActions,
  type RosterAction,
  type RosterReceipt,
  type RosterSender,
} from "./rosterActions";

/** Lifecycle receipts wait for desktop application, not just relay acceptance. */
export function useRosterActions(admin: ReturnType<typeof useAdminCommands>) {
  const current = useRef(admin);
  current.current = admin;
  const waiters = useRef(
    new Map<string, (ack: { ok: boolean; error?: string }) => void>(),
  );
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [receipts, setReceipts] = useState<RosterReceipt[]>([]);
  useEffect(() => {
    for (const [id, resolve] of waiters.current) {
      const ack = admin.acks.get(id);
      if (ack) resolve(ack);
    }
  }, [admin.acks]);
  useEffect(
    () => () => {
      for (const resolve of waiters.current.values())
        resolve({
          ok: false,
          error: "Check status after reload — the command may still apply.",
        });
    },
    [],
  );
  const send: RosterSender = async (command, summary, options) => {
    const id = await current.current.send(command, summary, options);
    if (!id) return { ok: false, error: "The command could not be sent." };
    const ack = current.current.acks.get(id);
    if (ack) return ack;
    return new Promise((resolve) => {
      const timer = window.setTimeout(
        () =>
          finish({
            ok: false,
            error: `No answer from ${options?.target?.replace(/\.local$/, "") ?? "Buzz Desktop"} — it may still apply. Check status after reload.`,
          }),
        30_000,
      );
      const finish = (result: { ok: boolean; error?: string }) => {
        window.clearTimeout(timer);
        waiters.current.delete(id);
        resolve(result);
      };
      waiters.current.set(id, finish);
    });
  };
  const run = async (action: RosterAction, rows: readonly RosterRow[]) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setReceipts([]);
    try {
      setReceipts(await runRosterActions(rows, action, send));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return { run, busy, receipts };
}
