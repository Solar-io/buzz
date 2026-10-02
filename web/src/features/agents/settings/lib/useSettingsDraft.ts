import { useRef, useState } from "react";
import {
  draftKey,
  editSettingsDraft,
  planSettingsCommands,
  settingsDraftSummary,
  settingsEffectSummary,
  settingChangeSummary,
  undoSettingsDraft,
  type SettingDraftEntry,
  type SettingsDraft,
} from "./settingsDraft";
import {
  saveSettingsCommands,
  type SendSettingsCommand,
  type SettingsSaveResult,
} from "./settingsSave";
import type { SaveBarState } from "@/shared/ui/settings/SaveBar";

/** One memory-only draft per screen. The sender must await the desktop ack. */
export function useSettingsDraft(send: SendSettingsCommand) {
  const [draft, setDraft] = useState<SettingsDraft>(new Map());
  const [state, setState] = useState<SaveBarState>({ status: "idle" });
  const [undoEntries, setUndoEntries] = useState<readonly SettingDraftEntry[]>(
    [],
  );
  const [receipts, setReceipts] = useState<readonly SettingsSaveResult[]>([]);
  const saving = useRef(false);
  const uncertain = state.status === "error" && state.uncertain === true;
  function edit(entry: SettingDraftEntry) {
    if (saving.current || uncertain) return;
    setDraft((current) => editSettingsDraft(current, entry));
    setState({ status: "idle" });
    setUndoEntries([]);
  }
  function discard() {
    if (saving.current) return;
    setDraft(new Map());
    setState({ status: "idle" });
    setUndoEntries([]);
  }
  async function save(snapshot: SettingsDraft = draft) {
    if (saving.current || uncertain || snapshot.size === 0) return;
    saving.current = true;
    const machines = [
      ...new Set([...snapshot.values()].map((entry) => entry.machine)),
    ];
    setState({ status: "sending", machines });
    try {
      const results = await saveSettingsCommands(
        planSettingsCommands(snapshot),
        send,
      );
      setReceipts(results);
      const applied = results
        .filter((result) => result.ack.ok)
        .flatMap((result) => result.plan.entries);
      const failed = results.filter((result) => !result.ack.ok);
      setDraft((current) => {
        const remaining = new Map(current);
        for (const entry of applied) remaining.delete(draftKey(entry));
        return remaining;
      });
      setUndoEntries(applied);
      setState(
        failed.length > 0
          ? {
              status: "error",
              uncertain: failed.some((result) => result.timedOut),
              errors: failed.map((result) => ({
                machine: result.plan.machine,
                agentName: result.plan.entries[0]?.agentName,
                error:
                  result.ack.error ??
                  result.ack.message ??
                  "The desktop did not apply the change.",
                timedOut: result.timedOut,
              })),
            }
          : { status: "saved", machines, savedAt: Date.now() },
      );
    } catch (error) {
      setState({
        status: "error",
        errors: [
          {
            machine: machines.join(", "),
            error: error instanceof Error ? error.message : String(error),
          },
        ],
      });
    } finally {
      saving.current = false;
    }
  }
  async function undo() {
    if (undoEntries.length === 0 || draft.size > 0 || saving.current) return;
    const inverse = undoSettingsDraft(undoEntries);
    setDraft(inverse);
    setUndoEntries([]);
    await save(inverse);
    // An undo is itself acknowledged, but never offers an endless redo loop.
    setUndoEntries([]);
  }
  return {
    draft,
    state,
    receipts,
    edit,
    discard,
    save: () => save(),
    undo,
    dirty: draft.size > 0,
    busy: state.status === "sending",
    uncertain,
    canUndo:
      state.status === "saved" && undoEntries.length > 0 && draft.size === 0,
    summary: settingsDraftSummary(draft),
    changes: [...draft.values()].map(settingChangeSummary),
    effectSummary: settingsEffectSummary(draft),
  };
}
