import { useEffect, useRef, useState } from "react";
import { ownPubkey } from "@/shared/lib/nostr-signer";
import { relayWsUrl } from "@/shared/lib/relay-url";
import type { RosterRow } from "../../../lib/roster";
import type { useAdminCommands } from "../../../ui/AgentAdminPanel";
import type { ApiKeySelection } from "../../../lib/providerApiKey";
import { providerSecretEnvVar } from "../../../lib/providerApiKey";
import { useSettingsDraft } from "../../lib/useSettingsDraft";
import { awaitSettingsAck } from "./awaitSettingsAck";
import {
  buildCardUpdate,
  settingBaseline,
  readTimeoutEcho,
  writeTimeoutEcho,
  SETTINGS_FIELDS,
  UNREPORTED,
  type SettingsEcho,
  type AgentSettingField,
} from "./agentSettingsFields";

/** Screen draft: secrets stay out of W7 receipts; echo changes only after apply. */
export function useAgentCardDraft(
  row: RosterRow,
  admin: ReturnType<typeof useAdminCommands>,
  enabled: boolean,
) {
  const [echo, setEcho] = useState<SettingsEcho>({});
  const [echoKey, setEchoKey] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState<ApiKeySelection>({ kind: "keep" });
  const ackRef = useRef(admin.acks);
  ackRef.current = admin.acks;
  const machine = row.machines[0] ?? "Buzz Desktop";
  useEffect(() => {
    let alive = true;
    void ownPubkey().then((owner) => {
      if (!alive || !owner) return;
      const key = `buzz-settings-timeouts:${owner}:${relayWsUrl()}:${row.pubkey}:${machine}`;
      setEchoKey(key);
      try {
        setEcho(readTimeoutEcho(sessionStorage, key));
      } catch {
        /* Memory-only when storage is unavailable. */
      }
    });
    return () => {
      alive = false;
    };
  }, [row.pubkey, machine]);
  useEffect(() => {
    // A newer public projection supersedes transient non-timeout echoes.
    setEcho((current) =>
      Object.fromEntries(
        Object.entries(current).filter(
          ([field]) =>
            field === "idleTimeoutSeconds" ||
            field === "maxTurnDurationSeconds",
        ),
      ),
    );
  }, [row.entry.updatedAt, row.persona?.updatedAt]);
  const draft = useSettingsDraft(async (plan) => {
    if (
      !enabled ||
      row.machines.length !== 1 ||
      row.machines[0] !== plan.machine
    )
      return {
        ok: false,
        error: "Needs a current report from one Buzz Desktop.",
      };
    const provider =
      plan.request.provider ?? settingBaseline(row, echo, "provider");
    const built = buildCardUpdate(
      plan,
      row,
      apiKey,
      providerSecretEnvVar(String(provider))?.envVar ?? null,
    );
    if ("error" in built) return { ok: false, error: built.error };
    const requestId = await admin.send(built.command, `Update ${row.name}`, {
      target: plan.machine,
    });
    if (!requestId)
      return { ok: false, error: "The command was not accepted by the relay." };
    const ack = await awaitSettingsAck(requestId, () => ackRef.current);
    if (ack.ok) {
      const next = { ...echo };
      for (const entry of plan.entries)
        if (entry.field !== "apiKey")
          next[entry.field as AgentSettingField] =
            entry.change.kind === "clear" ? null : entry.change.value;
      setEcho(next);
      if (echoKey) writeTimeoutEcho(sessionStorage, echoKey, next);
      setApiKey({ kind: "keep" });
    }
    return ack;
  });
  const value = (field: AgentSettingField) => {
    const edit = draft.draft.get(`${row.pubkey}:${field}`);
    return edit
      ? edit.change.kind === "clear"
        ? null
        : edit.change.value
      : settingBaseline(row, echo, field);
  };
  const edit = (
    field: AgentSettingField,
    next: string | number | boolean | null,
  ) => {
    if (!enabled) return;
    const baseline = settingBaseline(row, echo, field);
    draft.edit({
      agentPubkey: row.pubkey,
      agentName: row.name,
      machine,
      field,
      label: SETTINGS_FIELDS[field][0],
      original: {
        value: baseline,
        inherited: baseline === null,
        label: baseline === UNREPORTED ? "Not reported" : String(baseline),
      },
      clearValue: SETTINGS_FIELDS[field][1],
      defaultLabel:
        field === "idleTimeoutSeconds"
          ? "15 min — built in"
          : field === "maxTurnDurationSeconds"
            ? "12 h — built in"
            : "Desktop default",
      takesEffect: "on-restart",
      change: next === null ? { kind: "clear" } : { kind: "set", value: next },
    });
    if (field === "harness") onApiKey({ kind: "keep" });
  };
  const onApiKey = (next: ApiKeySelection) => {
    setApiKey(next);
    // Constant summary markers: never put the secret in a draft or receipt.
    edit(
      "apiKey",
      next.kind === "keep"
        ? UNREPORTED
        : next.kind === "clear"
          ? "Remove key"
          : "Set new key",
    );
  };
  const canUndo =
    draft.canUndo &&
    draft.receipts.every((receipt) =>
      receipt.plan.entries.every(
        (entry) =>
          entry.field !== "apiKey" && entry.original.value !== UNREPORTED,
      ),
    );
  return {
    draft,
    value,
    edit,
    apiKey,
    onApiKey,
    canUndo,
    discard: () => {
      draft.discard();
      setApiKey({ kind: "keep" });
    },
  };
}
