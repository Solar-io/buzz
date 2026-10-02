import { useEffect, useId, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Copy, Square } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { truncatePubkey } from "@/shared/lib/pubkey";
import type { RelaySession } from "@/shared/api/relay-session";
import type { ChannelSummary } from "@/features/channels/useChannels";
import type { ActiveTurn } from "@/features/work/lib/activeTurns";
import type { ObserverFrame } from "../../lib/observerEvents";
import {
  sendAgentControl,
  type SwitchModelCommand,
  type CancelTurnCommand,
} from "../../lib/agentControl";
import { formatElapsed } from "../../ui/WorkingBadge";
import type { RosterRow } from "../../lib/roster";
import { conversationModel } from "./agentScreenModel";

export function RightNowCard({
  row,
  turns,
  lastFinished,
  queued,
  channels,
  session,
  enabled,
  models,
  frames,
}: {
  row: RosterRow;
  turns: readonly ActiveTurn[];
  lastFinished: ObserverFrame | null;
  queued: number;
  channels: readonly ChannelSummary[];
  session: RelaySession;
  enabled: boolean;
  models: readonly string[];
  frames: readonly ObserverFrame[];
}) {
  const [channelId, setChannelId] = useState("");
  const [modelId, setModelId] = useState("");
  const [busy, setBusy] = useState(false);
  const listId = useId();
  useEffect(() => {
    if (!channels.some((channel) => channel.id === channelId)) {
      setChannelId(
        turns.find((turn) =>
          channels.some((channel) => channel.id === turn.channelId),
        )?.channelId ??
          channels[0]?.id ??
          "",
      );
    }
  }, [channels, channelId, turns]);
  const run = async (
    command:
      | Omit<SwitchModelCommand, "requestId">
      | Omit<CancelTurnCommand, "requestId">,
  ) => {
    if (!enabled || busy || !channelId) return;
    setBusy(true);
    try {
      const result = await sendAgentControl(session, row.pubkey, {
        ...command,
        requestId: crypto.randomUUID(),
      });
      if (result.ok) toast.success(result.message);
      else toast.error(result.message);
    } finally {
      setBusy(false);
    }
  };
  const current = turns.find((turn) => turn.channelId === channelId);
  return (
    <section
      className="min-w-0 space-y-3 rounded-xl border border-border bg-card p-4"
      data-testid="agent-right-now"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Right now</h2>
        {turns.length ? (
          <span className="rounded-full bg-honey-soft px-2 py-0.5 text-xs text-honey-ink">
            {turns.length} working
          </span>
        ) : null}
      </div>
      <p className="text-sm">
        {turns.length
          ? `${turns.length} turn${turns.length === 1 ? "" : "s"} in progress`
          : "No turn in progress"}
      </p>
      {channels.length ? (
        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">Conversation</span>
          <select
            className="h-11 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm md:h-9"
            value={channelId}
            onChange={(event) => setChannelId(event.target.value)}
          >
            {channels.map((channel) => (
              <option key={channel.id} value={channel.id}>
                {channel.name || "Conversation"}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {current ? (
        <p className="text-xs text-muted-foreground">
          Started {formatElapsed(current.startedAt, Date.now() / 1000)} ago
          {current.state !== "live"
            ? ` · ${current.state === "stalled" ? "No recent heartbeat" : "Lost contact"}`
            : ""}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">{queued} waiting</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="min-h-11 md:min-h-8"
          disabled={!enabled || busy || !current}
          onClick={() => void run({ type: "cancel_turn", channelId })}
        >
          <Square aria-hidden className="mr-1 h-3 w-3" />
          Cancel turn
        </Button>
        {channelId ? (
          <Link
            to="/repos"
            search={{ c: channelId }}
            className="inline-flex min-h-11 items-center text-xs text-blue-ink md:min-h-8"
          >
            Open channel
          </Link>
        ) : null}
      </div>
      {lastFinished ? (
        <p className="border-t border-border pt-3 text-xs text-muted-foreground">
          Last finished ·{" "}
          {new Date(lastFinished.createdAt * 1000).toLocaleTimeString([], {
            hour: "numeric",
            minute: "2-digit",
          })}
        </p>
      ) : null}
      <div className="space-y-2 border-t border-border pt-3">
        <label htmlFor={listId} className="block text-xs text-muted-foreground">
          This conversation’s model
        </label>
        {conversationModel(frames, channelId) ? (
          <p className="break-words text-sm" data-testid="agent-live-model">
            {conversationModel(frames, channelId)}
          </p>
        ) : null}
        <Input
          id={listId}
          aria-label="Live model"
          className="min-h-11 md:min-h-9"
          value={modelId}
          onChange={(event) => setModelId(event.target.value)}
          list={`${listId}-models`}
          placeholder="Choose a model"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
        <datalist id={`${listId}-models`}>
          {models.map((model) => (
            <option key={model} value={model} />
          ))}
        </datalist>
        <Button
          variant="outline"
          size="sm"
          className="min-h-11 md:min-h-8"
          disabled={!enabled || busy || !channelId || !modelId.trim()}
          onClick={() =>
            void run({
              type: "switch_model",
              channelId,
              modelId: modelId.trim(),
            })
          }
        >
          Switch model
        </Button>
        <p className="text-xs text-muted-foreground">
          Changes this conversation. Your saved model stays the same.
        </p>
      </div>
      <div className="flex min-w-0 items-center gap-2 border-t border-border pt-2">
        <span className="text-xs text-muted-foreground">Runs as</span>
        <code
          className="min-w-0 flex-1 truncate text-right text-xs"
          title={row.pubkey}
        >
          {truncatePubkey(row.pubkey)}
        </code>
        <Button
          size="icon"
          variant="ghost"
          className="h-11 w-11 md:h-8 md:w-8"
          aria-label="Copy agent key"
          onClick={() =>
            void navigator.clipboard
              .writeText(row.pubkey)
              .then(() => toast.success("Agent key copied."))
              .catch(() => toast.error("Could not copy the key."))
          }
        >
          <Copy aria-hidden className="h-3.5 w-3.5" />
        </Button>
      </div>
    </section>
  );
}
