import { useEffect, useMemo, useState } from "react";
import { AlertCircle, ArrowLeft } from "lucide-react";
import { ownPubkey } from "@/shared/lib/nostr-signer";
import { useProfiles, type Profile } from "@/features/channels/hooks";
import type { DesktopCatalog } from "../lib/desktopCatalog.ts";
import { buildCatalogCreate } from "../lib/personaCatalogInstall.ts";
import type { CatalogPublication } from "../lib/personaCatalog.ts";
import {
  snapshotAddFeedback,
  type SnapshotAddFeedback,
} from "../lib/pendingCommands.ts";
import type { AdminAckEnvelope, AdminCommand } from "../lib/adminCommands.ts";
import { useTick } from "./WorkingBadge.tsx";
import { usePersonaCatalog } from "../usePersonaCatalog.ts";

/**
 * The community persona catalog (Phase 3 §2.2 B6) — the web counterpart of
 * the desktop's PersonaCatalogDialog, as a pane on the agents screen.
 * Browse + byte-for-byte review work for EVERY signed-in member: the
 * all-authors subscription is filtered by the relay's shared-gate, and the
 * projection mirrors the desktop parser (personaCatalog.ts), so the list is
 * relay-confirmed publications ONLY — never an optimistic local persona
 * (desktop AGENTS.md rule 10).
 *
 * The detail pane is a rule-12 surface: the system prompt renders as literal
 * text in a <pre>, never the chat Markdown projection, which can conceal
 * content (link destinations, spoilers, image sources). The parser already
 * REJECTED invisible/formatting characters before this pane saw the string;
 * what is shown is byte-for-byte what the desktop would execute.
 *
 * "Add agent from catalog" exists only for a session with ≥1 desktop catalog
 * (the 24201 channel needs a desktop to apply it) — otherwise the honest
 * note, not a dead button. Install = copy semantics, owner-only, not
 * auto-started (personaCatalogInstall.ts).
 */

/** Render cap for the list — a hostile flood cannot DOM-bomb the pane. */
const CATALOG_RENDER_CAP = 200;

type AdminCommandsApi = {
  send: (
    command: AdminCommand,
    summary: string,
    options?: { target?: string },
  ) => Promise<string | null>;
  acks: Map<string, AdminAckEnvelope>;
};

export function PersonaCatalogPanel({
  admin,
  catalogs,
}: {
  admin: AdminCommandsApi;
  catalogs: DesktopCatalog[];
}) {
  const { publications } = usePersonaCatalog();
  const [selfPubkey, setSelfPubkey] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void ownPubkey().then((pubkey) => {
      if (alive) {
        setSelfPubkey(pubkey);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  const sorted = useMemo(
    () =>
      [...publications.values()].sort((left, right) =>
        left.agent.displayName.localeCompare(right.agent.displayName),
      ),
    [publications],
  );
  const ownerPubkeys = useMemo(
    () => [...new Set(sorted.map((p) => p.ownerPubkey))],
    [sorted],
  );
  const profiles = useProfiles(ownerPubkeys);
  const selected = selectedKey ? (publications.get(selectedKey) ?? null) : null;

  return (
    <div className="grid min-h-0 gap-4 md:grid-cols-[240px_minmax(0,1fr)]">
      <div
        className={selected ? "min-w-0 md:block hidden" : "min-w-0"}
        data-testid="web-catalog-list"
      >
        <p className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
          Agent catalog · {sorted.length} shared
        </p>
        {sorted.length === 0 ? (
          <p className="space-y-2 text-sm text-muted-foreground">
            No shared agents yet. Agents appear here once their owners publish
            them to the catalog from the Buzz desktop app — never before the
            relay confirms the publication.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border bg-card">
            {sorted.slice(0, CATALOG_RENDER_CAP).map((publication) => {
              const isSelected =
                selectedKey ===
                `${publication.ownerPubkey}:${publication.sourcePersonaId}`;
              return (
                <li
                  key={`${publication.ownerPubkey}:${publication.sourcePersonaId}`}
                >
                  <button
                    type="button"
                    aria-current={isSelected ? "true" : undefined}
                    className={
                      "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-accent/50 " +
                      (isSelected ? "bg-accent" : "")
                    }
                    onClick={() =>
                      setSelectedKey(
                        `${publication.ownerPubkey}:${publication.sourcePersonaId}`,
                      )
                    }
                  >
                    <CatalogAvatar
                      label={publication.agent.displayName}
                      ownerPubkey={publication.ownerPubkey}
                      avatarUrl={publication.agent.avatarUrl}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {publication.agent.displayName}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {ownerLabel(publication, selfPubkey, profiles)}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
            {sorted.length > CATALOG_RENDER_CAP ? (
              <li className="px-2 py-2 text-xs text-muted-foreground">
                +{sorted.length - CATALOG_RENDER_CAP} more not shown
              </li>
            ) : null}
          </ul>
        )}
      </div>

      <div className="min-w-0">
        {selected ? (
          <CatalogDetail
            key={selected.eventId}
            publication={selected}
            admin={admin}
            catalogs={catalogs}
            selfPubkey={selfPubkey}
            profile={profiles.get(selected.ownerPubkey)}
            onBack={() => setSelectedKey(null)}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            {sorted.length > 0
              ? "Pick a shared agent to review its instructions byte-for-byte."
              : "The catalog lists only agents their owners shared with the community."}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Owner label — mirror of the desktop's resolveCatalogOwnerLabel +
 * PersonaCatalogDetail: own publications are "You"; community entries prefer
 * the owner's kind-0 displayName, then name, then "Community member".
 */
export function ownerLabel(
  publication: CatalogPublication,
  selfPubkey: string | null,
  profiles: ReadonlyMap<string, Profile>,
): string {
  if (selfPubkey && publication.ownerPubkey === selfPubkey.toLowerCase()) {
    return "You";
  }
  const profile = profiles.get(publication.ownerPubkey);
  return (
    profile?.displayName.trim() || profile?.name.trim() || "Community member"
  );
}

/** Catalog avatar: publication art when present, else an owner-keyed bubble. */
function CatalogAvatar({
  label,
  ownerPubkey,
  avatarUrl,
  size = "sm",
}: {
  label: string;
  ownerPubkey: string;
  avatarUrl: string | null;
  size?: "sm" | "lg";
}) {
  // avatarUrl already passed the safeAvatar mirror (http/https or inline
  // image data only); an SVG in an <img> cannot execute script.
  const box = size === "lg" ? "h-12 w-12 text-base" : "h-6 w-6 text-[10px]";
  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt=""
        className={`shrink-0 rounded-full object-cover ${box}`}
      />
    );
  }
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-full font-semibold text-white ${box}`}
      style={{ backgroundColor: `hsl(${pubkeyHue(ownerPubkey)}, 45%, 42%)` }}
    >
      {label.slice(0, 2)}
    </span>
  );
}

/** Deterministic hue from a pubkey — same identicon fallback as the roster. */
function pubkeyHue(pubkey: string): number {
  let hash = 0;
  for (let i = 0; i < pubkey.length; i++) {
    hash = (hash * 31 + pubkey.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

/**
 * Security review surface for instructions that will execute verbatim.
 * (Mirrors the desktop's AgentInstructionReview, doc comment and all.)
 *
 * Do not replace this <pre> with the chat Markdown renderer: Markdown
 * intentionally hides spoiler bodies, link destinations, and image sources,
 * so the reviewed text would differ from the system prompt sent to the agent.
 */
function AgentInstructionReview({ instructions }: { instructions: string }) {
  return (
    <pre
      className="mt-2 max-h-72 overflow-auto rounded bg-muted/60 p-3 text-xs whitespace-pre-wrap break-words"
      data-testid="web-catalog-instructions"
    >
      {instructions || "No instructions included."}
    </pre>
  );
}

const RESPOND_TO_LABELS: Record<string, string> = {
  "owner-only": "Owner only",
  anyone: "Anyone in the community",
};

function CatalogDetail({
  publication,
  admin,
  catalogs,
  selfPubkey,
  profile,
  onBack,
}: {
  publication: CatalogPublication;
  admin: AdminCommandsApi;
  catalogs: DesktopCatalog[];
  selfPubkey: string | null;
  profile?: Profile;
  onBack: () => void;
}) {
  const { agent } = publication;
  const [sent, setSent] = useState<{
    requestId: string;
    sentAt: number;
  } | null>(null);

  const built = useMemo(
    () => buildCatalogCreate(publication, catalogs),
    [publication, catalogs],
  );
  const hasCatalog = catalogs.length > 0;

  const ack = sent ? admin.acks.get(sent.requestId) : undefined;
  // 1s re-render while the command ages without an ack (same clock as the
  // snapshot Add button — without it the "?" state computes once).
  useTick(sent !== null && !ack);
  const feedback: SnapshotAddFeedback = snapshotAddFeedback(
    sent?.sentAt ?? null,
    ack,
    Date.now(),
  );

  const chips = [agent.runtime, agent.model, agent.provider].filter(Boolean);
  const isOwn =
    selfPubkey != null && publication.ownerPubkey === selfPubkey.toLowerCase();
  const sharedBy = isOwn
    ? "You"
    : profile?.displayName.trim() || profile?.name.trim() || "Community member";

  async function handleAdd() {
    if (!("command" in built)) {
      return; // The button cannot be reached in this state; guard anyway.
    }
    const id = await admin.send(
      built.command,
      `Add ${agent.displayName} (catalog)`,
      built.target ? { target: built.target } : undefined,
    );
    if (id) {
      setSent({ requestId: id, sentAt: Date.now() });
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <CatalogAvatar
          label={agent.displayName}
          ownerPubkey={publication.ownerPubkey}
          avatarUrl={agent.avatarUrl}
          size="lg"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-semibold">
            {agent.displayName}
          </p>
          <p className="text-xs text-muted-foreground">
            Shared by {sharedBy} ·{" "}
            {new Date(publication.createdAt * 1000).toLocaleDateString([], {
              month: "short",
              day: "numeric",
              year: "numeric",
            })}
          </p>
        </div>
        <button
          type="button"
          className="rounded p-1 text-muted-foreground hover:bg-accent md:hidden"
          onClick={onBack}
          aria-label="Back to catalog"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
      </div>

      {chips.length > 0 ? (
        <p className="flex flex-wrap gap-1">
          {chips.map((chip) => (
            <span
              key={chip}
              className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
            >
              {chip}
            </span>
          ))}
        </p>
      ) : null}

      <p className="text-xs text-muted-foreground">
        Who can use it:{" "}
        {agent.respondTo
          ? (RESPOND_TO_LABELS[agent.respondTo] ?? agent.respondTo)
          : "Not specified by the publisher"}
      </p>

      <section className="space-y-2">
        <div>
          <p className="text-sm font-medium">Agent instructions</p>
          <p className="text-xs text-muted-foreground">
            Review the instructions this agent will follow. Shown literally —
            exactly the bytes the publisher shared.
          </p>
        </div>
        <AgentInstructionReview instructions={agent.systemPrompt} />
      </section>

      {/* Install area — honest-absent when no desktop can apply the command. */}
      <section className="space-y-2 border-t border-border pt-3">
        {!hasCatalog ? (
          <p className="text-sm text-muted-foreground">
            No Buzz desktop is connected. Agents are created by your desktop —
            open the Buzz desktop app to add this agent.
          </p>
        ) : "error" in built ? (
          // Nothing installable (e.g. a publication with no instructions) —
          // the honest message, not a button that would refuse on send.
          <p
            className="text-sm text-muted-foreground"
            data-testid="web-catalog-add-unavailable"
          >
            {built.error}
          </p>
        ) : (
          <>
            {"command" in built && built.notes.length > 0 ? (
              <ul className="space-y-1 text-xs text-muted-foreground">
                {built.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            ) : null}
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                data-testid="web-catalog-add-agent"
                disabled={
                  feedback.phase === "sending" || feedback.phase === "applied"
                }
                onClick={() => void handleAdd()}
              >
                {feedback.phase === "sending"
                  ? "Sending…"
                  : feedback.phase === "applied"
                    ? "Sent"
                    : "command" in built && built.target
                      ? `Add agent on ${built.target}`
                      : "Add agent from catalog"}
              </button>
              <span className="text-xs text-muted-foreground">
                Creates your own copy — owner-only, not auto-started.
              </span>
            </div>
            {feedback.phase === "sending" ? (
              <p className="text-xs text-muted-foreground">
                Waiting for the desktop to apply and acknowledge…
              </p>
            ) : null}
            {feedback.phase === "no-response" ? (
              <p
                className="text-xs text-amber-500 dark:text-amber-400"
                data-testid="web-catalog-add-no-response"
              >
                No desktop responded. Is Buzz running? The command wasn't
                acknowledged, so it wasn't applied — you can try again.
              </p>
            ) : null}
            {feedback.phase === "applied" ? (
              <p className="text-xs text-emerald-600 dark:text-emerald-400">
                Agent created — it appears in the roster as owner-only and not
                running.
              </p>
            ) : null}
            {feedback.phase === "refused" ? (
              <div
                className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
                data-testid="web-catalog-add-refused"
              >
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <p className="break-words">
                  {feedback.error ?? "The desktop refused the command."}
                </p>
              </div>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
