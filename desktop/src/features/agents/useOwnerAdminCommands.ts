import * as React from "react";

import {
  createManagedAgent,
  deleteManagedAgent,
  unregisterManagedAgent,
  updateManagedAgent,
} from "@/shared/api/tauri";
import {
  startManagedAgent,
  stopManagedAgent,
} from "@/shared/api/tauriManagedAgents";
import { relayClient } from "@/shared/api/relayClient";
import {
  decryptOwnerAdminPayload,
  publishOwnerAdminAck,
} from "@/shared/api/tauriOwnerAdmin";
import {
  commandTargetsThisMachine,
  parseOwnerAdminCommand,
  type OwnerAdminCommand,
} from "./ownerAdminProtocol";
import { useIdentityQuery } from "@/shared/api/hooks";
import { normalizePubkey } from "@/shared/lib/pubkey";
import { getMachineHostname } from "@/shared/api/machineIdentity";

/**
 * Owner admin-command ingestion (kind 24201): applies web-issued agent
 * management through the desktop's own save paths and acks on kind 24202.
 * Mounted once in AppShell beside useAgentObserverIngestion.
 *
 * Trust: the payload is NIP-44 sealed to the owner's own key and the signer
 * must equal our pubkey — the owner key is the admin credential, same trust
 * domain as every other owner-signed write. Commands are deduped by
 * requestId (ephemeral redelivery can replay).
 *
 * Machine targeting: when the envelope carries `target` (a hostname, from
 * the web's kind-30180 catalog), only the desktop whose hostname matches
 * applies it. Without the gate, an owner running Desktop on two machines
 * would mint every web-issued create twice (two pubkeys, two 30177s). A
 * targeted command this machine does not own is dropped silently, no ack —
 * the targeted machine acks. A missing hostname lookup fails closed: a
 * targeted command is never applied by a machine that cannot prove it is
 * the target.
 */
export function useOwnerAdminCommands() {
  const identityQuery = useIdentityQuery();
  const ownerPubkey = identityQuery.data?.pubkey;
  const seenRequestIds = React.useRef(new Set<string>());

  const handleOwnerAdminEvent = React.useCallback(
    async (event: { content: string }) => {
      let command: OwnerAdminCommand | null = null;
      try {
        const payload = await decryptOwnerAdminPayload(event.content);
        command = parseOwnerAdminCommand(payload);
      } catch {
        // Sealed to a different key or malformed — not ours, drop silently.
        return;
      }
      if (!command) {
        return;
      }
      if (command.target) {
        const hostname = await getMachineHostname();
        if (!commandTargetsThisMachine(command, hostname)) {
          return;
        }
      }
      if (seenRequestIds.current.has(command.requestId)) {
        return;
      }
      seenRequestIds.current.add(command.requestId);
      // Bounded dedupe memory: a command older than the session is gone
      // anyway (ephemeral), so cap the set.
      if (seenRequestIds.current.size > 500) {
        seenRequestIds.current.clear();
      }

      try {
        const agentPubkey = await applyOwnerAdminCommand(command);
        await publishOwnerAdminAck({
          requestId: command.requestId,
          ok: true,
          ...(agentPubkey ? { agentPubkey } : {}),
        });
      } catch (error) {
        await publishOwnerAdminAck({
          requestId: command.requestId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }).catch(() => {
          // Ack failure must not crash ingestion; the web side times out.
        });
      }
    },
    [],
  );

  React.useEffect(() => {
    if (!ownerPubkey) {
      return;
    }
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    void relayClient
      .subscribeLive(
        { kinds: [24201], authors: [ownerPubkey], limit: 50 },
        (event) => {
          // Author filter already scopes delivery; this is the hard gate.
          if (normalizePubkey(event.pubkey) !== normalizePubkey(ownerPubkey)) {
            return;
          }
          void handleOwnerAdminEvent(event);
        },
      )
      .then((teardown) => {
        if (disposed) {
          teardown();
        } else {
          unsubscribe = teardown;
        }
      });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [ownerPubkey, handleOwnerAdminEvent]);
}

async function applyOwnerAdminCommand(
  command: OwnerAdminCommand,
): Promise<string | null> {
  switch (command.action) {
    case "create": {
      const harnessFields = command.harness
        ? command.harness.kind === "preset"
          ? { acpCommand: command.harness.runtimeId }
          : {
              agentCommand: command.harness.command,
              agentArgs: command.harness.args,
              harnessOverride: true,
            }
        : {};
      const { agent } = await createManagedAgent({
        name: command.name,
        systemPrompt: command.systemPrompt,
        ...(command.avatarUrl ? { avatarUrl: command.avatarUrl } : {}),
        ...(command.model ? { model: command.model } : {}),
        ...(command.provider ? { provider: command.provider } : {}),
        ...harnessFields,
        ...(command.envVars ? { envVars: command.envVars } : {}),
        ...(command.parallelism ? { parallelism: command.parallelism } : {}),
        ...(command.respondTo ? { respondTo: command.respondTo } : {}),
        ...(command.respondToAllowlist
          ? { respondToAllowlist: command.respondToAllowlist }
          : {}),
        ...(command.spawnAfterCreate !== undefined
          ? { spawnAfterCreate: command.spawnAfterCreate }
          : {}),
        ...(command.startOnAppLaunch !== undefined
          ? { startOnAppLaunch: command.startOnAppLaunch }
          : {}),
      });
      return agent.pubkey;
    }
    case "update": {
      const harnessFields = command.harness
        ? command.harness.kind === "preset"
          ? { acpCommand: command.harness.runtimeId }
          : {
              agentCommand: command.harness.command,
              agentArgs: command.harness.args,
              harnessOverride: true,
            }
        : {};
      // UpdateManagedAgentInput carries no avatarUrl or timeout fields —
      // those ride the create path or the desktop dialog.
      const { agent } = await updateManagedAgent({
        pubkey: command.pubkey,
        ...(command.name ? { name: command.name } : {}),
        ...(command.systemPrompt ? { systemPrompt: command.systemPrompt } : {}),
        ...(command.model ? { model: command.model } : {}),
        ...(command.provider ? { provider: command.provider } : {}),
        ...harnessFields,
        ...(command.envVars ? { envVars: command.envVars } : {}),
        ...(command.parallelism ? { parallelism: command.parallelism } : {}),
        ...(command.respondTo ? { respondTo: command.respondTo } : {}),
        ...(command.respondToAllowlist
          ? { respondToAllowlist: command.respondToAllowlist }
          : {}),
      });
      return agent.pubkey;
    }
    case "delete":
      await deleteManagedAgent(command.pubkey, command.forceRemoteDelete);
      return null;
    case "unregister":
      await unregisterManagedAgent(command.pubkey);
      return null;
    case "start":
      await startManagedAgent(command.pubkey);
      return command.pubkey;
    case "stop":
      await stopManagedAgent(command.pubkey);
      return command.pubkey;
  }
}
