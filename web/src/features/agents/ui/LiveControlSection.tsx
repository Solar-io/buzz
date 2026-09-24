import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import type { RelaySession } from "@/shared/api/relay-session";
import { signNostrEvent } from "@/shared/lib/nostr-signer";
import { publishChannelMemberAdds } from "@/features/channels/lib/addChannelMembers";
import {
  sendAgentControl,
  type AgentControlCommand,
} from "../lib/agentControl";
import { useAgentChannels } from "../useAgentChannels";
import { SectionHeading } from "./AgentFormSections";

/**
 * Live owner→agent control for the SELECTED agent (no agent dropdown — the
 * roster is the picker). Same frames the desktop's model picker sends. The
 * channel comes from a picker over the channels the agent is a member of
 * (kind-39002 snapshots); "Add to channel" publishes the same kind-9000
 * member add as the desktop's add_channel_members, role `bot`.
 */

const SELECT_CLASS =
  "h-9 w-full rounded-md border border-input bg-background px-2 text-sm";

function newRequestId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `req-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}

export function LiveControlSection({
  session,
  agentPubkey,
  modelSuggestions,
}: {
  session: RelaySession;
  agentPubkey: string;
  modelSuggestions: readonly string[];
}) {
  const { member, others, refresh } = useAgentChannels(agentPubkey);
  const [channelId, setChannelId] = useState("");
  const [modelId, setModelId] = useState("");
  const [busy, setBusy] = useState(false);
  const listId = useId();

  // Keep the selection valid as the member list arrives/changes.
  useEffect(() => {
    if (!member.some((channel) => channel.id === channelId)) {
      setChannelId(member[0]?.id ?? "");
    }
  }, [member, channelId]);

  const run = async (command: AgentControlCommand) => {
    setBusy(true);
    try {
      const result = await sendAgentControl(session, agentPubkey, command);
      if (result.ok) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    } finally {
      setBusy(false);
    }
  };

  const noChannels = member.length === 0;

  return (
    <div className="space-y-3">
      <SectionHeading>Live control</SectionHeading>
      <div className="block space-y-1">
        <span className="block text-sm text-muted-foreground">
          Channel (the conversation the command applies to)
        </span>
        {noChannels ? (
          <p className="text-sm text-muted-foreground">
            This agent isn't in any channel you can see.
          </p>
        ) : (
          <select
            aria-label="Channel"
            className={SELECT_CLASS}
            value={channelId}
            onChange={(event) => setChannelId(event.target.value)}
          >
            {member.map((channel) => (
              <option key={channel.id} value={channel.id}>
                {channel.name || channel.id}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy || noChannels || !channelId}
          onClick={() =>
            void run({
              type: "cancel_turn",
              channelId,
              requestId: newRequestId(),
            })
          }
        >
          Cancel current turn
        </Button>
        <div className="min-w-0 flex-1 space-y-1">
          <span className="block text-sm text-muted-foreground">Model id</span>
          <Input
            aria-label="Model id"
            value={modelId}
            onChange={(event) => setModelId(event.target.value)}
            placeholder="e.g. glm-5.3"
            list={listId}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
          <datalist id={listId}>
            {modelSuggestions.map((model) => (
              <option key={model} value={model} />
            ))}
          </datalist>
        </div>
        <Button
          size="sm"
          disabled={busy || noChannels || !modelId.trim() || !channelId}
          onClick={() =>
            void run({
              type: "switch_model",
              channelId,
              modelId: modelId.trim(),
              requestId: newRequestId(),
            })
          }
        >
          Switch model
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Commands ride the relay's owner→agent control channel — the same frames
        the desktop's model picker sends.
      </p>
      <AddToChannel
        session={session}
        agentPubkey={agentPubkey}
        others={others}
        onAdded={refresh}
      />
    </div>
  );
}

function AddToChannel({
  session,
  agentPubkey,
  others,
  onAdded,
}: {
  session: RelaySession;
  agentPubkey: string;
  others: readonly { id: string; name: string }[];
  /** Re-query membership — the relay may not push the new 39002 live. */
  onAdded: () => void;
}) {
  const [channelId, setChannelId] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!others.some((channel) => channel.id === channelId)) {
      setChannelId(others[0]?.id ?? "");
    }
  }, [others, channelId]);

  if (others.length === 0) {
    return null;
  }

  const add = async () => {
    const channel = others.find((c) => c.id === channelId);
    if (!channel) {
      return;
    }
    setBusy(true);
    try {
      const outcome = await publishChannelMemberAdds({
        channelId: channel.id,
        members: [{ pubkey: agentPubkey, role: "bot" }],
        send: async (event) => session.publish(await signNostrEvent(event)),
      });
      if (outcome.failures[0]) {
        toast.error(outcome.failures[0].message);
      } else if (outcome.added.length > 0) {
        toast.success(`Added to ${channel.name || channel.id}`);
        onAdded();
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not add to channel.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="min-w-0 flex-1 space-y-1">
        <span className="block text-sm text-muted-foreground">
          Add to channel
        </span>
        <select
          aria-label="Add to channel"
          className={SELECT_CLASS}
          value={channelId}
          onChange={(event) => setChannelId(event.target.value)}
        >
          {others.map((channel) => (
            <option key={channel.id} value={channel.id}>
              {channel.name || channel.id}
            </option>
          ))}
        </select>
      </div>
      <Button
        size="sm"
        variant="outline"
        disabled={busy || !channelId}
        onClick={() => void add()}
      >
        {busy ? "Adding…" : "Add"}
      </Button>
    </div>
  );
}
