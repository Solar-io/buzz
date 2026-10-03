/**
 * Claude accounts (two-account pool routing) — per-agent pool assignment and
 * a both-accounts view, edited remotely on the owner's Buzz Desktop.
 *
 * Data: the desktop's kind-30180 catalog (v3+) carries `claude_pools_sealed`,
 * a NIP-44 ciphertext sealed to the owner's own key. It is decrypted here
 * with the owner signer — never rendered or stored in plaintext elsewhere.
 * Save sends the existing owner admin command (kind 24201) `set_claude_pools`
 * — a full-document replace guarded by the loaded file hash — and the
 * desktop acks on kind 24202. Changes apply on each agent's next
 * wake/restart; nothing restarts here.
 */

import { useEffect, useMemo, useState } from "react";

import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { nip44DecryptFrom, ownPubkey } from "@/shared/lib/nostr-signer";
import { useDesktopCatalogs } from "@/features/agents/useDesktopCatalogs";
import { useDesktopPresence } from "@/features/agents/useDesktopPresence";
import { adminCommandLock } from "@/features/agents/lib/adminCommandLock";
import { DesktopControlBoundary } from "@/features/agents/ui/DesktopControlBoundary";
import { useAdminCommands } from "@/features/agents/ui/useAdminCommands";
import type { DesktopCatalog } from "@/features/agents/lib/desktopCatalog";
import type { ClaudePoolsConfig } from "@/features/agents/lib/adminCommands";
import type { AdminCommand } from "@/features/agents/lib/adminCommands";
import type { AdminSendOptions } from "@/features/agents/lib/admin/protocolV5";
import {
  CLAUDE_POOLS_CATALOG_VERSION,
  nextPoolsConfig,
  parseClaudePoolsPayload,
  type ClaudePoolsPayload,
} from "@/features/agents/lib/claudePools";

import { USAGE_HUB_URL } from "@/features/usage/lib/usageHub";

export { USAGE_HUB_URL };

const SELECT_CLASS =
  "rounded-md border border-input bg-card px-2 py-1 text-sm disabled:opacity-50";

function useDecryptedPools(catalog: DesktopCatalog | null): {
  payload: ClaudePoolsPayload | null;
  error: string | null;
} {
  const [state, setState] = useState<{
    payload: ClaudePoolsPayload | null;
    error: string | null;
  }>({ payload: null, error: null });
  const sealed = catalog?.claudePoolsSealed ?? null;
  useEffect(() => {
    if (!sealed) {
      setState({ payload: null, error: null });
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const me = await ownPubkey();
        if (!me) {
          throw new Error("No unlocked key.");
        }
        const { plaintext } = await nip44DecryptFrom(sealed, me);
        const payload = parseClaudePoolsPayload(JSON.parse(plaintext));
        if (alive) {
          setState({
            payload,
            error: payload ? null : "Unrecognized pools payload.",
          });
        }
      } catch (error) {
        if (alive) {
          setState({
            payload: null,
            error:
              error instanceof Error
                ? error.message
                : "Could not decrypt the pools block.",
          });
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [sealed]);
  return state;
}

export function ClaudePoolsSection({
  lockedReason,
}: {
  lockedReason?: (
    command: AdminCommand,
    options?: AdminSendOptions,
  ) => string | null;
} = {}) {
  const catalogs = useDesktopCatalogs();
  const presence = useDesktopPresence(catalogs);
  const capable = catalogs.filter(
    (c) => c.version >= CLAUDE_POOLS_CATALOG_VERSION && c.claudePoolsSealed,
  );
  const [machine, setMachine] = useState<string | null>(null);
  const catalog =
    capable.find((c) => c.machine === machine) ?? capable[0] ?? null;
  const { payload, error } = useDecryptedPools(catalog);
  const { session, status } = useRelaySession();
  const admin = useAdminCommands(
    session,
    status,
    lockedReason ??
      ((command, options) =>
        adminCommandLock(command, options, catalogs, presence.byMachine)
          .reason),
  );

  if (capable.length === 0) {
    // Hidden until a v3 desktop publishes the sealed block.
    return null;
  }

  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-medium">Claude accounts</h2>
        {capable.length > 1 ? (
          <select
            className={SELECT_CLASS}
            aria-label="Desktop"
            value={catalog?.machine ?? ""}
            onChange={(event) => setMachine(event.target.value)}
          >
            {capable.map((c) => (
              <option key={c.machine} value={c.machine}>
                {c.machine}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-xs text-muted-foreground">
            {catalog?.machine}
          </span>
        )}
      </div>
      <a
        className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        data-testid="usage-hub-link"
        href={USAGE_HUB_URL}
        rel="noreferrer"
        target="_blank"
      >
        Real usage and quota per account → usage-hub
      </a>
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {!payload && !error ? (
        <p className="text-sm text-muted-foreground" role="status">
          Decrypting…
        </p>
      ) : null}
      {payload && catalog ? (
        <DesktopControlBoundary {...presence.lock([catalog.machine])}>
          <PoolsEditor
            key={`${catalog.machine}:${payload.hash}`}
            payload={payload}
            onSave={(config) =>
              admin.send(
                {
                  action: "set_claude_pools",
                  request: { config, baseHash: payload.hash },
                },
                "Save Claude pool assignments",
                { target: catalog.machine },
              )
            }
            acks={admin.acks}
          />
        </DesktopControlBoundary>
      ) : null}
    </section>
  );
}

const EMPTY_CONFIG: ClaudePoolsConfig = {
  version: 1,
  default: "A",
  pools: {
    A: { label: "Account A", configDir: null },
    B: { label: "Account B", configDir: "~/cc2" },
  },
  assign: {},
  overflow: { enabled: true, cooldownMinutes: 60 },
};

function PoolsEditor({
  payload,
  onSave,
  acks,
}: {
  payload: ClaudePoolsPayload;
  onSave: (config: ClaudePoolsConfig) => Promise<string | null>;
  acks: Map<string, { ok: boolean; error?: string }>;
}) {
  const base = payload.config ?? EMPTY_CONFIG;
  const [pools, setPools] = useState(base.pools);
  const [defaultPool, setDefaultPool] = useState(base.default);
  const [agentPools, setAgentPools] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      payload.agents
        .filter((a) => a.eligible)
        .map((a) => [a.name, a.pool ?? base.default]),
    ),
  );
  const [requestId, setRequestId] = useState<string | null>(null);
  const poolIds = useMemo(() => Object.keys(pools).sort(), [pools]);
  const ack = requestId ? acks.get(requestId) : undefined;

  return (
    <div className="space-y-3">
      {payload.parseError ? (
        <p className="text-sm text-destructive" role="alert">
          agent-pools.json on this desktop does not parse: {payload.parseError}.
          Saving replaces it.
        </p>
      ) : null}
      {!payload.config && !payload.parseError ? (
        <p className="text-sm text-muted-foreground">
          Pool routing is off on this desktop. Saving creates
          ~/.buzz/agent-pools.json.
        </p>
      ) : null}

      <div className="space-y-2">
        <h3 className="text-sm font-medium">Accounts</h3>
        {poolIds.map((id) => {
          const account = payload.accounts[id];
          return (
            <div
              key={id}
              className="grid grid-cols-1 gap-2 rounded-md border border-border p-2 sm:grid-cols-3"
            >
              <div className="text-sm">
                <div className="font-medium">
                  Pool {id}
                  {defaultPool === id ? " (default)" : ""}
                </div>
                <div className="text-xs text-muted-foreground">
                  {account
                    ? account.loggedIn
                      ? `${account.email ?? "unknown email"}${
                          account.subscriptionType
                            ? ` · ${account.subscriptionType}`
                            : ""
                        }`
                      : `Not logged in${account.error ? ` — ${account.error}` : ""}`
                    : "Login not checked yet"}
                </div>
                <div className="text-xs text-muted-foreground">
                  {
                    payload.agents.filter(
                      (a) =>
                        a.eligible &&
                        (agentPools[a.name] ?? defaultPool) === id,
                    ).length
                  }{" "}
                  agent(s)
                </div>
              </div>
              <Input
                aria-label={`Pool ${id} label`}
                value={pools[id]?.label ?? ""}
                placeholder="Label"
                onChange={(event) =>
                  setPools({
                    ...pools,
                    [id]: { ...pools[id], label: event.target.value || null },
                  })
                }
              />
              <Input
                aria-label={`Pool ${id} config dir`}
                value={pools[id]?.configDir ?? ""}
                placeholder="(default ~/.claude — leave empty)"
                onChange={(event) =>
                  setPools({
                    ...pools,
                    [id]: {
                      ...pools[id],
                      configDir: event.target.value.trim() || null,
                    },
                  })
                }
              />
            </div>
          );
        })}
        <label className="flex items-center gap-2 text-sm">
          Default pool
          <select
            className={SELECT_CLASS}
            value={defaultPool}
            onChange={(event) => setDefaultPool(event.target.value)}
          >
            {poolIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="space-y-1">
        <h3 className="text-sm font-medium">Agents</h3>
        <ul className="divide-y divide-border rounded-md border border-border">
          {payload.agents.map((agent) => (
            <li
              key={agent.pubkey}
              className={`flex items-center justify-between gap-2 px-2 py-1 text-sm ${
                agent.eligible ? "" : "text-muted-foreground opacity-60"
              }`}
            >
              <span className="truncate">{agent.name}</span>
              {agent.eligible ? (
                <select
                  className={SELECT_CLASS}
                  aria-label={`${agent.name} pool`}
                  value={agentPools[agent.name] ?? defaultPool}
                  onChange={(event) =>
                    setAgentPools({
                      ...agentPools,
                      [agent.name]: event.target.value,
                    })
                  }
                >
                  {poolIds.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="text-xs">
                  {agent.reason === "custom-auth"
                    ? "custom auth"
                    : "not a Claude harness"}
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>

      <div className="flex items-center gap-3">
        <Button
          size="sm"
          disabled={requestId !== null && !ack}
          onClick={async () => {
            const config = nextPoolsConfig(base, {
              defaultPool,
              pools,
              agentPools,
            });
            setRequestId(await onSave(config));
          }}
        >
          Save
        </Button>
        <span className="text-xs text-muted-foreground" role="status">
          {ack
            ? ack.ok
              ? "Saved on the desktop."
              : `Desktop refused: ${ack.error ?? "unknown error"}`
            : requestId
              ? "Sent — waiting for the desktop…"
              : "Applies on each agent's next wake/restart."}
        </span>
      </div>
    </div>
  );
}
