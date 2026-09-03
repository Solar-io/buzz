import {
  fromRawManagedAgent,
  invokeTauri,
  type RawManagedAgent,
} from "@/shared/api/tauri";
import type {
  ManagedAgent,
  ManagedAgentRuntimeStatus,
} from "@/shared/api/types";

export async function startManagedAgent(
  pubkey: string,
  options?: {
    /** Tenant scope captured by the caller before its first await; the
     * backend fails closed before any spawn/deploy side effect when the
     * active community no longer matches. */
    expectedRelayUrl?: string;
    /** Signer identity captured with the relay scope; the backend fails
     * closed when the active workspace identity no longer matches. */
    expectedSignerPubkey?: string;
  },
): Promise<ManagedAgent> {
  const response = await invokeTauri<RawManagedAgent>("start_managed_agent", {
    pubkey,
    expectedRelayUrl: options?.expectedRelayUrl ?? null,
    expectedSignerPubkey: options?.expectedSignerPubkey ?? null,
  });
  return fromRawManagedAgent(response);
}

export async function stopManagedAgent(pubkey: string): Promise<ManagedAgent> {
  const response = await invokeTauri<RawManagedAgent>("stop_managed_agent", {
    pubkey,
  });
  return fromRawManagedAgent(response);
}

export async function setManagedAgentStartOnAppLaunch(
  pubkey: string,
  startOnAppLaunch: boolean,
): Promise<ManagedAgent> {
  const response = await invokeTauri<RawManagedAgent>(
    "set_managed_agent_start_on_app_launch",
    {
      pubkey,
      startOnAppLaunch,
    },
  );
  return fromRawManagedAgent(response);
}

export async function setManagedAgentAutoRestart(
  pubkey: string,
  autoRestartOnConfigChange: boolean,
): Promise<ManagedAgent> {
  const response = await invokeTauri<RawManagedAgent>(
    "set_managed_agent_auto_restart",
    {
      pubkey,
      autoRestartOnConfigChange,
    },
  );
  return fromRawManagedAgent(response);
}

/**
 * B5: persist the canonical startup effort for a local managed agent. Applied
 * as `BUZZ_ACP_EFFORT_LEVEL` at the next spawn. Pass `null` to clear (reverts
 * to the adapter default). Rejects non-local agents.
 */
export async function persistAgentEffortLevel(
  pubkey: string,
  effortLevel: string | null,
): Promise<void> {
  return invokeTauri<void>("persist_agent_effort_level", {
    pubkey,
    effortLevel,
  });
}

export async function listManagedAgentRuntimes(): Promise<
  ManagedAgentRuntimeStatus[]
> {
  return invokeTauri<ManagedAgentRuntimeStatus[]>(
    "list_managed_agent_runtimes",
  );
}

export async function startManagedAgentRuntime(
  pubkey: string,
  relayUrl: string,
): Promise<ManagedAgentRuntimeStatus> {
  return invokeTauri("start_managed_agent_runtime", { pubkey, relayUrl });
}

export async function stopManagedAgentRuntime(
  pubkey: string,
  relayUrl: string,
): Promise<ManagedAgentRuntimeStatus> {
  return invokeTauri("stop_managed_agent_runtime", { pubkey, relayUrl });
}

export async function restartManagedAgentRuntime(
  pubkey: string,
  relayUrl: string,
): Promise<ManagedAgentRuntimeStatus> {
  return invokeTauri("restart_managed_agent_runtime", { pubkey, relayUrl });
}

export async function putManagedAgentRuntimeLifecycle(
  outerPubkey: string,
  payload: unknown,
): Promise<ManagedAgentRuntimeStatus> {
  return invokeTauri("put_managed_agent_runtime_lifecycle", {
    outerPubkey,
    payload,
  });
}

export async function reconcileManagedAgentRuntimes(
  communities: readonly { relayUrl: string }[],
): Promise<ManagedAgentRuntimeStatus[]> {
  return invokeTauri("reconcile_managed_agent_runtimes", { communities });
}

/**
 * Delete a managed agent: stops any process, removes the local record, and
 * WIPES the keyring key (after a 0o600 backup export — backend invariant).
 * The backend refuses a running agent unless forceRunningDelete is explicit.
 */
export async function deleteManagedAgent(
  pubkey: string,
  forceRemoteDelete?: boolean,
  forceRunningDelete?: boolean,
): Promise<void> {
  await invokeTauri("delete_managed_agent", {
    pubkey,
    forceRemoteDelete: forceRemoteDelete ?? null,
    forceRunningDelete: forceRunningDelete ?? null,
  });
}

/**
 * Remove the RELAY registration for an agent (kind-5 tombstone + NIP-IA
 * archive) without stopping a process, removing a local record, or touching
 * the keyring. Refuses agents this desktop owns locally — those must go
 * through delete (the reconciler would otherwise re-publish the 30177).
 */
export async function unregisterManagedAgent(pubkey: string): Promise<void> {
  await invokeTauri("unregister_managed_agent", { pubkey });
}
