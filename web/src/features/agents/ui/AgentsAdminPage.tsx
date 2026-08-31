import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Link } from "@tanstack/react-router";
import { Button } from "@/shared/ui/button";
import { useAuth } from "@/features/auth/ui/AuthProvider";
import { LoginPage } from "@/features/auth/ui/LoginPage";
import type { RelaySession } from "@/shared/api/relay-session";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { useObserverStore } from "@/features/agents/ObserverProvider";
import { useProfiles } from "@/features/channels/hooks";
import {
  publishOwnProfile,
  sendAgentControl,
  type AgentControlCommand,
} from "../lib/agentControl";

function newRequestId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `req-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}

/**
 * Agent admin for the web, scoped to what the protocol allows the OWNER to
 * do remotely: live control commands (switch model, cancel turn) over
 * owner→agent kind-24200 control frames, plus own profile (kind 0).
 *
 * Not here by design: agent creation and prompt edits. Those ride the
 * agent→owner telemetry channel (relay-enforced direction), which only an
 * agent's own key can send — the owner's web session is protocol-invalid
 * there. Creating agents stays a desktop action.
 */
export function AgentsAdminPage() {
  const { canSign } = useAuth();
  const { session } = useRelaySession();
  const observerStore = useObserverStore();

  if (!canSign) {
    return <LoginPage />;
  }
  return (
    <div className="mx-auto max-w-2xl space-y-6 p-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Agents</h1>
        <Button asChild variant="ghost" size="sm">
          <Link to="/repos/settings">Back to settings</Link>
        </Button>
      </div>
      <AgentCommands observerStore={observerStore} session={session} />
      <ProfileEditor session={session} />
    </div>
  );
}

function AgentCommands({
  observerStore,
  session,
}: {
  observerStore: ReturnType<typeof useObserverStore>;
  session: RelaySession;
}) {
  // Agents known from the observer store — every agent that has emitted
  // frames to you this session.
  const agentPubkeys = useMemo(
    () => Array.from(observerStore?.byAgent.keys() ?? []).sort(),
    [observerStore],
  );
  const profiles = useProfiles(agentPubkeys);
  const [selected, setSelected] = useState("");
  const [modelId, setModelId] = useState("");
  const [channelId, setChannelId] = useState("");
  const [busy, setBusy] = useState(false);

  const agent = selected || agentPubkeys[0] || "";
  const label = (pubkey: string) =>
    profiles.get(pubkey)?.displayName ?? `${pubkey.slice(0, 8)}…`;

  const run = async (command: AgentControlCommand) => {
    if (!agent) {
      toast.error("No agents known yet — they appear once they report in.");
      return;
    }
    setBusy(true);
    try {
      const result = await sendAgentControl(session, agent, command);
      if (result.ok) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-4">
      <h2 className="font-medium">Running agents</h2>
      {agentPubkeys.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No agents have reported in this session yet.
        </p>
      ) : (
        <>
          <label className="block space-y-1">
            <span className="text-sm text-muted-foreground">Agent</span>
            <select
              value={agent}
              onChange={(event) => setSelected(event.target.value)}
              className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
              aria-label="Agent"
            >
              {agentPubkeys.map((pubkey) => (
                <option key={pubkey} value={pubkey}>
                  {label(pubkey)}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1">
            <span className="text-sm text-muted-foreground">
              Channel id (the conversation the command applies to)
            </span>
            <input
              value={channelId}
              onChange={(event) => setChannelId(event.target.value)}
              placeholder="channel UUID — copy from the URL ?c=…"
              className="w-full rounded-md border border-input bg-card px-3 py-2 font-mono text-xs"
            />
          </label>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !channelId.trim()}
            onClick={() =>
              void run({
                type: "cancel_turn",
                channelId: channelId.trim(),
                requestId: newRequestId(),
              })
            }
          >
            Cancel current turn
          </Button>
          <div className="flex items-end gap-2">
            <label className="min-w-0 flex-1 space-y-1">
              <span className="text-sm text-muted-foreground">Model id</span>
              <input
                value={modelId}
                onChange={(event) => setModelId(event.target.value)}
                placeholder="e.g. glm-5.3"
                className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
              />
            </label>
            <Button
              size="sm"
              disabled={busy || !modelId.trim() || !channelId.trim()}
              onClick={() =>
                void run({
                  type: "switch_model",
                  channelId: channelId.trim(),
                  modelId: modelId.trim(),
                  requestId: newRequestId(),
                })
              }
            >
              Switch model
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Commands ride the relay's owner→agent control channel — the same
            frames the desktop's model picker sends.
          </p>
        </>
      )}
    </section>
  );
}

function ProfileEditor({ session }: { session: RelaySession }) {
  const [name, setName] = useState("");
  const [about, setAbout] = useState("");
  const [picture, setPicture] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim()) {
      toast.error("A name is required.");
      return;
    }
    setBusy(true);
    try {
      const result = await publishOwnProfile(session, {
        name: name.trim(),
        about: about.trim(),
        picture: picture.trim(),
      });
      if (result.ok) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-4">
      <h2 className="font-medium">Your profile</h2>
      <p className="text-sm text-muted-foreground">
        Published as your kind-0 metadata — the name other members and agents
        see.
      </p>
      <label className="block space-y-1">
        <span className="text-sm text-muted-foreground">Display name</span>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
        />
      </label>
      <label className="block space-y-1">
        <span className="text-sm text-muted-foreground">About</span>
        <textarea
          value={about}
          onChange={(event) => setAbout(event.target.value)}
          rows={3}
          className="w-full resize-y rounded-md border border-input bg-card px-3 py-2 text-sm"
        />
      </label>
      <label className="block space-y-1">
        <span className="text-sm text-muted-foreground">Avatar URL</span>
        <input
          value={picture}
          onChange={(event) => setPicture(event.target.value)}
          placeholder="https://…"
          className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
        />
      </label>
      <Button size="sm" disabled={busy} onClick={() => void submit()}>
        {busy ? "Publishing…" : "Save profile"}
      </Button>
    </section>
  );
}
