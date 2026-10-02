import { useEffect, useId, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Hash, X } from "lucide-react";
import { toast } from "sonner";
import type { RelaySession } from "@/shared/api/relay-session";
import { signNostrEvent } from "@/shared/lib/nostr-signer";
import { Button } from "@/shared/ui/button";
import type { useAgentChannels } from "../../useAgentChannels";
import type { useAdminCommands } from "../../ui/AgentAdminPanel";
import type { RosterRow } from "../../lib/roster";
import { targetForAgent } from "../../lib/roster";
import { addAgentChannel, removeAgentChannel } from "./agentChannelActions";

export interface AgentChannelsProps {
  row: RosterRow;
  channels: ReturnType<typeof useAgentChannels>;
  session: RelaySession;
  admin: ReturnType<typeof useAdminCommands>;
  enabled: boolean;
}

export function AgentChannelsCard({
  row,
  channels,
  session,
  admin,
  enabled,
  preview = true,
  onSeeAll,
}: AgentChannelsProps & {
  preview?: boolean;
  onSeeAll?: () => void;
}) {
  const { member, others, refresh } = channels;
  const [channelId, setChannelId] = useState("");
  const [busy, setBusy] = useState(false);
  const labelId = useId();
  useEffect(() => {
    if (!others.some((channel) => channel.id === channelId))
      setChannelId(others[0]?.id ?? "");
  }, [others, channelId]);
  const send = async (event: Parameters<typeof signNostrEvent>[0]) =>
    session.publish(await signNostrEvent(event));
  const run = async (work: () => Promise<unknown>) => {
    if (busy || !enabled) return;
    setBusy(true);
    try {
      await work();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not change membership.",
      );
    } finally {
      setBusy(false);
    }
  };
  const add = () =>
    run(async () => {
      const selected = others.find((channel) => channel.id === channelId);
      if (!selected) return;
      await addAgentChannel({
        channelId,
        pubkey: row.pubkey,
        sendMember: send,
        refresh,
        start: (command) =>
          admin.send(
            command,
            `Start ${row.name}`,
            targetForAgent(row.machines),
          ),
      });
      toast.success(`Added to ${selected.name}. Start sent to Buzz Desktop.`);
    });
  const shown = preview ? member.slice(0, 6) : member;
  return (
    <section
      className="min-w-0 space-y-3 rounded-xl border border-border bg-card p-4"
      data-testid={preview ? "agent-channels-card" : "agent-channels-tab"}
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">
          Channels{" "}
          <span className="ml-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {member.length}
          </span>
        </h2>
        {preview && onSeeAll ? (
          <Button
            size="sm"
            variant="ghost"
            className="min-h-11 text-blue-ink md:min-h-8"
            onClick={onSeeAll}
          >
            See all
          </Button>
        ) : null}
      </div>
      {!member.length ? (
        <p className="text-sm text-muted-foreground">
          No channels you can see yet.
        </p>
      ) : null}
      <ul className="space-y-1">
        {shown.map((channel) => (
          <li
            key={channel.id}
            className="group flex min-w-0 items-center gap-2 rounded-md hover:bg-muted"
          >
            <Hash
              aria-hidden
              className="h-4 w-4 shrink-0 text-muted-foreground"
            />
            <Link
              to="/repos"
              search={{ c: channel.id }}
              className="min-w-0 flex-1 truncate py-2 text-sm"
            >
              {channel.name || "Conversation"}
            </Link>
            <Button
              size="icon"
              variant="ghost"
              className="h-11 w-11 shrink-0 md:h-8 md:w-8"
              aria-label={`Remove from ${channel.name || "conversation"}`}
              disabled={!enabled || busy}
              onClick={() =>
                void run(async () => {
                  await removeAgentChannel(
                    channel.id,
                    row.pubkey,
                    send,
                    refresh,
                  );
                  toast.success(`Removed from ${channel.name}.`);
                })
              }
            >
              <X aria-hidden className="h-3.5 w-3.5" />
            </Button>
          </li>
        ))}
      </ul>
      {preview && member.length > shown.length ? (
        <button
          type="button"
          className="min-h-11 text-xs text-muted-foreground md:min-h-8"
          onClick={onSeeAll}
        >
          + {member.length - shown.length} more
        </button>
      ) : null}
      {others.length ? (
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <label
              htmlFor={labelId}
              className="mb-1 block text-xs text-muted-foreground"
            >
              Add to a channel
            </label>
            <select
              id={labelId}
              className="h-11 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm md:h-9"
              value={channelId}
              disabled={!enabled || busy}
              onChange={(event) => setChannelId(event.target.value)}
            >
              {others.map((channel) => (
                <option key={channel.id} value={channel.id}>
                  {channel.name || "Channel"}
                </option>
              ))}
            </select>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="min-h-11 md:min-h-9"
            disabled={!enabled || busy || !channelId}
            onClick={() => void add()}
          >
            {busy ? "Working…" : "Add"}
          </Button>
        </div>
      ) : null}
      {!enabled ? (
        <p className="text-xs text-muted-foreground">
          Connect to the relay and a current Buzz Desktop report to change
          channels.
        </p>
      ) : null}
    </section>
  );
}
