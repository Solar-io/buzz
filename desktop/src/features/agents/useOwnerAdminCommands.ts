import * as React from "react";

import { createManagedAgent, updateManagedAgent } from "@/shared/api/tauri";
import {
  deleteManagedAgent,
  startManagedAgent,
  stopManagedAgent,
  unregisterManagedAgent,
} from "@/shared/api/tauriManagedAgents";
import { relayClient } from "@/shared/api/relayClient";
import { setAgentPools } from "@/shared/api/tauriAgentPools";
import {
  decryptOwnerAdminPayload,
  publishOwnerAdminAck,
} from "@/shared/api/tauriOwnerAdmin";
import {
  commandTargetsThisMachine,
  parseOwnerAdminCommand,
  type OwnerAdminCommand,
} from "./ownerAdminProtocol";
import {
  createInputFromCommand,
  lifecycleCallsFromCommand,
  updateInputFromCommand,
} from "./ownerAdminAppliers";
import { useIdentityQuery } from "@/shared/api/hooks";
import { normalizePubkey } from "@/shared/lib/pubkey";
import { getMachineHostname } from "@/shared/api/machineIdentity";
import { executeOwnerAdminCommand } from "./ownerAdminProtocolV5";
import { ownerAdminReplayStore } from "./ownerAdminReplay";

/**
 * Owner admin-command ingestion (kind 24201): applies web-issued agent
 * management through the desktop's own save paths and acks on kind 24202.
 * Mounted once in AppShell beside useAgentObserverIngestion.
 *
 * Trust: the payload is NIP-44 sealed to the owner's own key and the signer
 * must equal our pubkey — the owner key is the admin credential, same trust
 * domain as every other owner-signed write. Commands are deduped by
 * requestId in persistent owner/machine receipts (ephemeral redelivery can
 * replay after a restart). Receipts expire only after command freshness does.
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
      const hostname = await getMachineHostname();
      if (!commandTargetsThisMachine(command, hostname)) {
        return;
      }
      if (!ownerPubkey) return;
      const ack = await executeOwnerAdminCommand(
        command,
        applyOwnerAdminCommand,
        hostname,
        // Lazily access storage inside claim: denied/unavailable storage
        // follows the same fail-closed ack path as a quota or corrupt receipt.
        ownerAdminReplayStore(
          {
            getItem: (key) => window.localStorage.getItem(key),
            setItem: (key, value) => window.localStorage.setItem(key, value),
          },
          normalizePubkey(ownerPubkey),
          hostname,
        ),
      );
      console.debug("Owner admin", {
        action: command.action,
        requestId: command.requestId,
        ok: ack.ok,
        code: ack.code,
      });
      await publishOwnerAdminAck(ack).catch(() => {
        // Ack failure must not crash ingestion; the web side times out.
      });
    },
    [ownerPubkey],
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
    case "ping":
      return null; // executeOwnerAdminCommand handles ping before the applier.
    case "create": {
      const { agent } = await createManagedAgent(
        createInputFromCommand(command),
      );
      return agent.pubkey;
    }
    case "update": {
      const { agent } = await updateManagedAgent(
        updateInputFromCommand(command),
      );
      return agent.pubkey;
    }
    case "delete":
      await deleteManagedAgent(command.pubkey, command.forceRemoteDelete);
      return null;
    case "unregister":
      await unregisterManagedAgent(command.pubkey);
      return null;
    case "start":
    case "stop":
    case "restart": {
      // Restart = stop-then-start over the same two Tauri commands; a stop
      // failure aborts before the start half runs (one ack, error side).
      for (const call of lifecycleCallsFromCommand(command)) {
        await (call.op === "stop"
          ? stopManagedAgent(call.pubkey)
          : startManagedAgent(call.pubkey));
      }
      return command.pubkey;
    }
    case "set_claude_pools":
      // Writes ~/.buzz/agent-pools.json only (validated + baseHash-guarded
      // in Rust). Takes effect on each agent's next wake/restart.
      await setAgentPools(
        { ...command.config, version: command.config.version ?? 1 },
        command.baseHash,
      );
      // The pools query polls every 60s, so the republished sealed catalog
      // block (with the new baseHash) follows without a cross-hook refetch.
      return null;
  }
}
