import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Lock } from "lucide-react";
import { fetchSignedBytes } from "@/shared/api/blossom";
import { useTick } from "@/features/agents/ui/WorkingBadge";
import type { DesktopCatalog } from "../lib/desktopCatalog.ts";
import {
  snapshotAddFeedback,
  type SnapshotAddFeedback,
} from "../lib/pendingCommands.ts";
import { buildSnapshotCreate } from "../lib/snapshotCreateRequest.ts";
import {
  decodeSnapshotBytes,
  fetchSnapshotBytesWeb,
  type AgentSnapshotView,
} from "../lib/snapshotManifest.ts";
import type { ResolvedSnapshotCard } from "@/features/channels/lib/snapshotCard.ts";
import type { AdminAckEnvelope, AdminCommand } from "../lib/adminCommands.ts";

/**
 * Verified snapshot review + honest Add-agent dialog (Phase 3 §2.1 A12) —
 * the web counterpart of the desktop's AgentSnapshotImportDialog.
 *
 * State machine: fetching → decode → {agent | locked | team | error}, with
 * errors surfaced VERBATIM (fetch/verify/decode failures are the signal, not
 * noise). For a decoded agent manifest this is a rule-12 surface: the system
 * prompt renders as literal text in a <pre> — never the chat markdown
 * projection, which can conceal content (desktop AGENTS.md rule 12). The
 * decoder already REJECTED default-ignorable/bidi/control characters before
 * this dialog saw the string; what is shown is byte-for-byte what would run.
 *
 * "Add agent on <machine>" exists ONLY when the snapshot is config-only,
 * validation passed, and ≥1 desktop catalog exists — otherwise the honest
 * note (memory/name-pool/prompt-less → desktop import; no desktop → nothing
 * to apply the command). Imports are always owner-only with
 * spawnAfterCreate false.
 */

type AdminCommandsApi = {
  send: (
    command: AdminCommand,
    summary: string,
    options?: { target?: string },
  ) => Promise<string | null>;
  acks: Map<string, AdminAckEnvelope>;
};

type DialogState =
  | { phase: "fetching" }
  | { phase: "error"; error: string }
  | { phase: "agent"; snapshot: AgentSnapshotView }
  | { phase: "locked"; refusal: string }
  | { phase: "team" };

export function SnapshotPreviewDialog({
  card,
  sharedBy,
  admin,
  catalogs,
  onClose,
}: {
  card: ResolvedSnapshotCard;
  sharedBy?: string;
  admin: AdminCommandsApi;
  catalogs: DesktopCatalog[];
  onClose: () => void;
}) {
  const [state, setState] = useState<DialogState>({ phase: "fetching" });
  const [sent, setSent] = useState<{
    requestId: string;
    sentAt: number;
  } | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setState({ phase: "fetching" });
    setSent(null);
    if (card.snapshotKind === "team") {
      // Team members each need full rule-12 review — desktop-only. No fetch:
      // the download on the card is the byte-accurate path for teams.
      setState({ phase: "team" });
      return;
    }
    fetchSnapshotBytesWeb(
      card.href,
      { filename: card.filename, sha256: card.sha256, size: card.size },
      { signedFetch: fetchSignedBytes },
    )
      .then((bytes) => {
        if (cancelled) {
          return;
        }
        const decoded = decodeSnapshotBytes(bytes);
        if (decoded.kind === "agent") {
          setState({ phase: "agent", snapshot: decoded.snapshot });
        } else if (decoded.kind === "locked") {
          setState({ phase: "locked", refusal: decoded.refusal });
        } else if (decoded.kind === "team") {
          setState({ phase: "team" });
        } else {
          setState({ phase: "error", error: decoded.error });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            phase: "error",
            error:
              error instanceof Error
                ? error.message
                : `Couldn't load this ${card.snapshotKind}. Try again.`,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [card.href, card.filename, card.sha256, card.size, card.snapshotKind]);

  const ack = sent ? admin.acks.get(sent.requestId) : undefined;
  // 1s re-render while the command ages without an ack — without a clock the
  // 20s "?" state below computes once at "Sending…" and never changes (the
  // same bug the pending strip fixed, QA 2026-09-02).
  useTick(sent !== null && !ack);
  const feedback = snapshotAddFeedback(sent?.sentAt ?? null, ack, Date.now());

  const machines = useMemo(
    () => catalogs.map((catalog) => catalog.machine),
    [catalogs],
  );
  const harnessIds = useMemo(
    () =>
      Array.from(
        new Set(catalogs.flatMap((c) => c.harnesses.map((h) => h.id))),
      ),
    [catalogs],
  );

  async function handleAdd(snapshot: AgentSnapshotView) {
    if (inFlight.current) {
      return;
    }
    const built = buildSnapshotCreate(snapshot, machines, harnessIds);
    if (!("command" in built)) {
      return; // The button cannot be reached in this state; guard anyway.
    }
    inFlight.current = true;
    try {
      const id = await admin.send(
        built.command,
        `Add ${snapshot.displayName} (snapshot)`,
        built.target ? { target: built.target } : undefined,
      );
      if (id) {
        setSent({ requestId: id, sentAt: Date.now() });
      }
    } finally {
      inFlight.current = false;
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      {/* Backdrop click dismisses; aria-hidden keeps it out of the a11y tree. */}
      <div className="absolute inset-0" aria-hidden onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Agent snapshot: ${card.displayName}`}
        data-testid="web-snapshot-preview"
        className="relative flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-lg"
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
          <h2 className="min-w-0 flex-1 truncate text-base font-semibold">
            {state.phase === "agent" || state.phase === "fetching"
              ? card.displayName
              : card.snapshotKind === "team"
                ? "Team snapshot"
                : "Agent snapshot"}
          </h2>
          <span className="shrink-0 text-xs text-muted-foreground">
            {card.filename}
          </span>
          <button
            type="button"
            aria-label="Close"
            className="ml-2 rounded p-1 text-muted-foreground hover:bg-accent"
            onClick={onClose}
          >
            ✕
          </button>
        </header>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {sharedBy ? (
            <p className="text-xs text-muted-foreground">
              Shared by {sharedBy}
            </p>
          ) : null}

          {state.phase === "fetching" && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Fetching and verifying the snapshot…
            </p>
          )}

          {state.phase === "error" && (
            <div
              className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              data-testid="web-snapshot-preview-error"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <p className="break-words">{state.error}</p>
            </div>
          )}

          {state.phase === "locked" && (
            <div className="space-y-3">
              <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
                <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <p>{state.refusal}</p>
              </div>
              <p className="text-sm text-muted-foreground">
                Locked cards can be imported in the Buzz desktop app, where the
                owner's or the agent's key can unlock them.
              </p>
            </div>
          )}

          {state.phase === "team" && (
            <p className="text-sm text-muted-foreground">
              This is a team snapshot. Each member agent carries its own
              instructions that need individual review — import teams in the
              Buzz desktop app. The download on the card saves the file
              byte-for-byte.
            </p>
          )}

          {state.phase === "agent" && (
            <AgentReviewBody
              snapshot={state.snapshot}
              machines={machines}
              harnessIds={harnessIds}
              hasCatalog={catalogs.length > 0}
              feedback={feedback}
              onAdd={() => void handleAdd(state.snapshot)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function AgentReviewBody({
  snapshot,
  machines,
  harnessIds,
  hasCatalog,
  feedback,
  onAdd,
}: {
  snapshot: AgentSnapshotView;
  machines: string[];
  harnessIds: string[];
  hasCatalog: boolean;
  feedback: SnapshotAddFeedback;
  onAdd: () => void;
}) {
  const built = useMemo(
    () => buildSnapshotCreate(snapshot, machines, harnessIds),
    [snapshot, machines, harnessIds],
  );
  const { definition } = snapshot;
  const chips = [
    definition.runtime,
    definition.model,
    definition.provider,
    definition.sourceIsBuiltin ? "built-in source" : null,
  ].filter(Boolean);

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-medium">{snapshot.displayName}</p>
        {chips.length > 0 && (
          <span className="flex flex-wrap gap-1">
            {chips.map((chip) => (
              <span
                key={chip}
                className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
              >
                {chip}
              </span>
            ))}
          </span>
        )}
      </div>

      {/* Portable behavior — the rule-12 surface: literal text, no markdown. */}
      <section
        className="space-y-2 rounded-md border border-border p-3"
        data-testid="web-snapshot-prompt"
      >
        <div>
          <p className="text-sm font-medium">Agent instructions</p>
          <p className="text-xs text-muted-foreground">
            Review the instructions this agent will follow. Shown literally —
            exactly the bytes that would run.
          </p>
        </div>
        <pre className="max-h-48 overflow-auto rounded bg-muted/60 p-3 text-xs whitespace-pre-wrap break-words">
          {definition.systemPrompt || "No system prompt included."}
        </pre>
      </section>

      <p className="text-sm text-muted-foreground">
        A new agent will be created with a fresh keypair. The imported agent is
        independent of the source — identity never travels.
      </p>

      {snapshot.memoryEntryCount > 0 ? (
        <div
          className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400"
          data-testid="web-snapshot-memory-warning"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>
            This snapshot includes{" "}
            <strong>
              {snapshot.memoryEntryCount}{" "}
              {snapshot.memoryLevel === "core" ? "core" : "all"} memory entr
              {snapshot.memoryEntryCount === 1 ? "y" : "ies"}
            </strong>
            . Memory is stored as plaintext in the file and needs the desktop
            importer to restore.
          </p>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          No memory included — config only.
        </p>
      )}

      {definition.respondToAllowlist.length > 0 && (
        <section className="space-y-2 rounded-md border border-border p-3">
          <p className="text-sm font-medium">
            Source respond-to allowlist ({definition.respondToAllowlist.length}{" "}
            entr{definition.respondToAllowlist.length === 1 ? "y" : "ies"})
          </p>
          <p className="text-xs text-muted-foreground">
            These pubkeys come from the sender's environment. A web import
            always starts owner-only — they are never copied.
          </p>
          <ul className="max-h-28 space-y-1 overflow-y-auto rounded bg-muted/60 p-2 font-mono text-xs">
            {definition.respondToAllowlist.map((pubkey) => (
              <li className="break-all" key={pubkey}>
                {pubkey}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Add-agent area — honest-absent when the precondition is missing. */}
      <section className="space-y-2 border-t border-border pt-3">
        {!hasCatalog ? (
          <p className="text-sm text-muted-foreground">
            No Buzz desktop is connected. Agents are created by your desktop —
            open the Buzz desktop app to import.
          </p>
        ) : "unavailable" in built ? (
          <div
            className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm"
            data-testid="web-snapshot-desktop-only"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <p>{built.unavailable}</p>
          </div>
        ) : (
          <>
            {"command" in built && built.notes.length > 0 && (
              <ul className="space-y-1 text-xs text-muted-foreground">
                {built.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            )}
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                data-testid="web-snapshot-add-agent"
                disabled={
                  feedback.phase === "sending" || feedback.phase === "applied"
                }
                onClick={onAdd}
              >
                {feedback.phase === "sending"
                  ? "Sending…"
                  : feedback.phase === "applied"
                    ? "Sent"
                    : "command" in built && built.target
                      ? `Add agent on ${built.target}`
                      : "Add agent"}
              </button>
              <span className="text-xs text-muted-foreground">
                Owner-only, not auto-started.
              </span>
            </div>
            {feedback.phase === "sending" && (
              <p className="text-xs text-muted-foreground">
                Waiting for the desktop to apply and acknowledge…
              </p>
            )}
            {feedback.phase === "no-response" && (
              // The pending strip's "?" honesty path, surfaced here: 20s with
              // no ack means no desktop applied it, so the button above is
              // re-enabled — retrying cannot mint the agent twice.
              <p
                className="text-xs text-amber-500 dark:text-amber-400"
                data-testid="web-snapshot-add-no-response"
              >
                No desktop responded. Is Buzz running? The command wasn't
                acknowledged, so it wasn't applied — you can try again.
              </p>
            )}
            {feedback.phase === "applied" && (
              <p className="text-xs text-emerald-600 dark:text-emerald-400">
                Agent created — it appears in the roster as owner-only and not
                running.
              </p>
            )}
            {feedback.phase === "refused" && (
              <p className="text-xs text-destructive">
                {feedback.error ?? "The desktop refused the command."}
              </p>
            )}
          </>
        )}
      </section>

      <details className="rounded-md border border-border p-3">
        <summary className="cursor-pointer text-sm font-medium">
          Full embedded manifest
        </summary>
        <p className="mt-2 text-xs text-muted-foreground">
          The complete portable payload decoded from the file. Secrets,
          credentials, and source identity are not part of the snapshot format.
        </p>
        <pre className="mt-2 max-h-64 overflow-auto rounded bg-muted/60 p-3 text-xs whitespace-pre-wrap break-words">
          {snapshot.manifestJson}
        </pre>
      </details>
    </div>
  );
}
