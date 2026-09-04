import { useCallback, useMemo, useRef, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { toast } from "sonner";

import type { RelaySession } from "@/shared/api/relay-session";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { Button } from "@/shared/ui/button";
import { Checkbox } from "@/shared/ui/checkbox";
import { cn } from "@/shared/lib/cn";
import { useChannels } from "@/features/channels/useChannels";

import { fetchDisplayNames } from "../lib/authorNames.ts";
import { archiveBlob, downloadBlob } from "../lib/downloadFile.ts";
import {
  type ExportFormat,
  archiveFileName,
  archiveMimeType,
  serializeArchive,
} from "../lib/exportFormat.ts";
import {
  DEFAULT_BOUNDS,
  describeStopReason,
  type ExportStopReason,
} from "../lib/exportPlan.ts";
import {
  KIND_GROUPS,
  defaultGroupIds,
  kindsForGroups,
  toggleGroupId,
} from "../lib/exportKinds.ts";
import {
  type ExportProgress,
  exportChannelEvents,
} from "../lib/exportChannel.ts";

/**
 * Export a channel's history to a file the viewer downloads.
 *
 * This is deliberately **not** the desktop app's local archive. Desktop
 * mirrors events into a local SQLite database in the background; a browser
 * tab has no silent filesystem, so the half a browser can genuinely do is
 * hand the user a file on demand. Nothing is written until the user asks,
 * and nothing keeps running once the download starts.
 */

type Phase = "idle" | "running" | "done";

interface Outcome {
  fileName: string;
  events: number;
  bytes: number;
  reason: ExportStopReason;
}

export function LocalArchiveSettingsCard(props: {
  /** Injected in tests and probes; defaults to the app's live relay session. */
  session?: Pick<RelaySession, "subscribe">;
}) {
  const live = useRelaySession();
  const session = props.session ?? live.session;
  const { channels } = useChannels();

  const exportable = useMemo(
    () =>
      channels
        .filter((channel) => !channel.archived && channel.type !== "dm")
        .sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
        ),
    [channels],
  );

  const [channelId, setChannelId] = useState<string | null>(null);
  const [format, setFormat] = useState<ExportFormat>("json");
  const [groups, setGroups] = useState<ReadonlySet<string>>(defaultGroupIds);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const selectedChannel =
    exportable.find((channel) => channel.id === channelId) ?? null;
  const kinds = useMemo(() => kindsForGroups(groups), [groups]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const run = useCallback(async () => {
    if (!selectedChannel || kinds.length === 0) {
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase("running");
    setProgress({ events: 0, pages: 0, oldestCreatedAt: null });
    setOutcome(null);
    try {
      const run = await exportChannelEvents({
        session,
        channelId: selectedChannel.id,
        kinds,
        bounds: DEFAULT_BOUNDS,
        signal: controller.signal,
        onProgress: setProgress,
      });
      const exportedAt = Math.floor(Date.now() / 1000);
      // Only the transcript renders names; skip the round-trip for JSON.
      const displayNames =
        format === "markdown"
          ? await fetchDisplayNames(session, run.events)
          : new Map<string, string>();
      const text = serializeArchive(
        format,
        run.events,
        {
          channelId: selectedChannel.id,
          channelName: selectedChannel.name,
          relayUrl: relayWsUrl(),
          exportedAt,
          kinds,
          bounds: DEFAULT_BOUNDS,
          reason: run.reason,
          sameTimestampPages: run.sameTimestampPages,
        },
        displayNames,
      );
      const fileName = archiveFileName(
        selectedChannel.name,
        exportedAt,
        format,
      );
      const blob = archiveBlob(text, archiveMimeType(format));
      downloadBlob(fileName, blob);
      setOutcome({
        fileName,
        events: run.events.length,
        bytes: blob.size,
        reason: run.reason,
      });
      setPhase("done");
    } catch (error) {
      setPhase("idle");
      toast.error(
        error instanceof Error
          ? `Export failed: ${error.message}`
          : "Export failed.",
      );
    } finally {
      abortRef.current = null;
    }
  }, [format, kinds, selectedChannel, session]);

  const running = phase === "running";

  return (
    <section
      className="space-y-3 rounded-lg border border-border bg-card p-4"
      data-testid="local-archive-card"
    >
      <div className="space-y-1">
        <h2 className="font-medium">Export channel history</h2>
        <p className="text-sm text-muted-foreground">
          Download everything this browser can read from a channel as a file.
          This is an export, not a background archive — Buzz Desktop keeps a
          continuously updated local copy, a web page can only hand you a
          snapshot when you ask for one.
        </p>
      </div>

      <div className="space-y-1">
        <span className="text-xs font-medium text-muted-foreground">
          Channel
        </span>
        {exportable.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No channels loaded yet.
          </p>
        ) : (
          <ul
            className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-border p-1"
            data-testid="local-archive-channels"
          >
            {exportable.map((channel) => (
              <li key={channel.id}>
                <button
                  type="button"
                  disabled={running}
                  aria-pressed={channel.id === channelId}
                  data-testid={`local-archive-channel-${channel.id}`}
                  onClick={() => setChannelId(channel.id)}
                  className={cn(
                    "w-full truncate rounded-sm px-2 py-1 text-left text-sm hover:bg-accent hover:text-accent-foreground disabled:opacity-50",
                    channel.id === channelId &&
                      "bg-accent text-accent-foreground",
                  )}
                >
                  #{channel.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <fieldset className="space-y-2" disabled={running}>
        <legend className="text-xs font-medium text-muted-foreground">
          Include
        </legend>
        {KIND_GROUPS.map((group) => (
          // biome-ignore lint/a11y/noLabelWithoutControl: the Checkbox below is the control, inside the label
          <label
            key={group.id}
            className="flex cursor-pointer items-start gap-2"
          >
            <Checkbox
              className="mt-0.5"
              checked={groups.has(group.id)}
              data-testid={`local-archive-group-${group.id}`}
              onCheckedChange={() =>
                setGroups((prev) => toggleGroupId(group.id, prev))
              }
            />
            <span className="space-y-0.5">
              <span className="block text-sm">{group.label}</span>
              <span className="block text-xs text-muted-foreground">
                {group.description}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      <div className="space-y-1">
        <span className="text-xs font-medium text-muted-foreground">
          Format
        </span>
        <div className="flex gap-2">
          <FormatButton
            active={format === "json"}
            disabled={running}
            onClick={() => setFormat("json")}
            testId="local-archive-format-json"
            title="Signed events (JSON)"
            subtitle="Lossless — signatures intact, re-verifiable later."
          />
          <FormatButton
            active={format === "markdown"}
            disabled={running}
            onClick={() => setFormat("markdown")}
            testId="local-archive-format-markdown"
            title="Transcript (Markdown)"
            subtitle="Readable — no signatures, no raw tags."
          />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={running || !selectedChannel || kinds.length === 0}
          data-testid="local-archive-export"
          onClick={() => void run()}
        >
          {running ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Download className="size-4" />
          )}
          {running ? "Exporting…" : "Export"}
        </Button>
        {running && (
          <Button
            variant="outline"
            size="sm"
            onClick={cancel}
            data-testid="local-archive-cancel"
          >
            Stop
          </Button>
        )}
      </div>

      {running && progress && (
        <p
          className="text-xs text-muted-foreground"
          data-testid="local-archive-progress"
          role="status"
        >
          {progress.events.toLocaleString()} events over {progress.pages} page
          {progress.pages === 1 ? "" : "s"}
          {progress.oldestCreatedAt !== null &&
            ` — back to ${new Date(progress.oldestCreatedAt * 1000)
              .toISOString()
              .slice(0, 10)}`}
        </p>
      )}

      {outcome && (
        <p
          className="text-xs text-muted-foreground"
          data-testid="local-archive-outcome"
        >
          Saved <span className="font-mono">{outcome.fileName}</span> —{" "}
          {outcome.events.toLocaleString()} events, {formatBytes(outcome.bytes)}
          . {describeStopReason(outcome.reason, DEFAULT_BOUNDS)}
        </p>
      )}

      <p className="text-xs text-muted-foreground">
        Ceilings: {DEFAULT_BOUNDS.maxEvents.toLocaleString()} events or{" "}
        {DEFAULT_BOUNDS.maxPages} relay pages, whichever comes first. Hitting
        one still produces a file — it keeps the newest history and says so.
      </p>
    </section>
  );
}

function FormatButton(props: {
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  testId: string;
  title: string;
  subtitle: string;
}) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      aria-pressed={props.active}
      data-testid={props.testId}
      onClick={props.onClick}
      className={cn(
        "flex-1 rounded-md border border-border p-2 text-left disabled:opacity-50",
        props.active ? "border-primary bg-accent" : "hover:bg-accent/50",
      )}
    >
      <span className="block text-sm">{props.title}</span>
      <span className="block text-xs text-muted-foreground">
        {props.subtitle}
      </span>
    </button>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
