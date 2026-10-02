import { PanelRightClose, Search, X } from "lucide-react";
import {
  type ReactNode,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

import { useProfiles } from "@/features/channels/hooks";
import { cn } from "@/shared/lib/cn";
import { reportWorkPage } from "@/shared/ui/toastStack.ts";
import { useWorkContext } from "../workContext.ts";
import { useNowSeconds, useWorkFeed } from "../useWorkFeed.ts";
import {
  loadCollapsedSections,
  loadWorkScope,
  saveCollapsedSections,
  saveWorkScope,
  subscribeWorkScope,
  type WorkSection,
} from "../lib/workPrefs.ts";
import { channelLabel } from "./workLabels.ts";
import type { NeedRow, WorkScope } from "../lib/workTypes.ts";
import { NeedsYouSection } from "./NeedsYouSection";
import type { NeedRowContext } from "./NeedRow";
import { DoneSection, QueuedSection } from "./QueuedSection";
import { RunningSection } from "./RunningSection";

const LG_QUERY = "(min-width: 64rem)";

function useMatches(query: string): boolean {
  const [matches, setMatches] = useState(
    () => globalThis.matchMedia?.(query).matches ?? true,
  );
  useEffect(() => {
    const list = globalThis.matchMedia?.(query);
    if (!list) {
      return;
    }
    const onChange = () => setMatches(list.matches);
    onChange();
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

type PhoneSection = "needs" | "running" | "queued";

/**
 * The Work tab (phase-1 §2; Main and PhoneWork artboards): Needs you, Running,
 * Queued and Done today, scoped Everywhere or to This channel.
 *
 * `rail` is the docked right pane at lg; `page` is `?view=work` below lg —
 * the phone's home screen, with the section chips and 44 px touch targets.
 */
export function WorkTab({
  variant,
  channelId,
  showTitle = true,
  onCollapse,
  onOpenMessage,
  onOpenChannel,
  onOpenView,
  onJump,
  vitals,
  onClearChannel,
}: {
  variant: "rail" | "page";
  /**
   * The open conversation; null on view pages ("This channel" disables). On
   * the Work PAGE a channel id means "opened for this channel" (`/status`).
   */
  channelId: string | null;
  /** The page's "#channel only" chip was dismissed. */
  onClearChannel?: () => void;
  /** False when the tab strip above already names the tab. */
  showTitle?: boolean;
  onCollapse?: () => void;
  onOpenMessage: (channelId: string, messageId: string) => void;
  onOpenChannel: (channelId: string) => void;
  onOpenView: (view: "workflows" | "reminders") => void;
  onJump?: () => void;
  vitals?: ReactNode;
}) {
  const context = useWorkContext();
  // A store, not local state: `/status` sets the scope from the composer.
  const scope = useSyncExternalStore<WorkScope>(
    subscribeWorkScope,
    loadWorkScope,
    () => "everywhere",
  );
  const [collapsed, setCollapsed] = useState(() => loadCollapsedSections());
  const [phoneSection, setPhoneSection] = useState<PhoneSection>("needs");
  const [fast, setFast] = useState(false);
  const nowS = useNowSeconds(fast ? 1_000 : 15_000);
  // The page has no scope toggle: it is Everywhere unless it was opened FOR a
  // channel (`/status` on a phone), and then it is that channel until the
  // chip is dismissed.
  const effectiveScope: WorkScope =
    variant === "page"
      ? channelId
        ? "channel"
        : "everywhere"
      : channelId
        ? scope
        : "everywhere";
  const feed = useWorkFeed({ scope: effectiveScope, channelId, nowS });

  const ticking = feed.running.some((row) => row.state !== "reacting");
  useEffect(() => setFast(ticking), [ticking]);

  // Needs-you toasts stay quiet while a Work surface is actually on screen.
  const lg = useMatches(LG_QUERY);
  const reportVisible = context?.reportVisible;
  const onScreen = variant === "page" || lg;
  useEffect(() => reportVisible?.(onScreen), [reportVisible, onScreen]);
  // The phone's decision toasts stay down over this page (toastStack.ts).
  useEffect(
    () => (variant === "page" ? reportWorkPage() : undefined),
    [variant],
  );

  const pubkeys = useMemo(
    () =>
      Array.from(
        new Set([
          ...feed.needs.flatMap((row) =>
            row.actorPubkey ? [row.actorPubkey] : [],
          ),
          ...feed.running.map((row) => row.agentPubkey),
          ...feed.queued.map((row) => row.agentPubkey),
          // Every Done row names its agent, not just the folded summary's.
          ...(feed.done.state === "ready"
            ? feed.done.rows.map((row) => row.agentPubkey)
            : []),
          // Whoever asked for the work, named on the row's second line.
          ...[
            ...feed.running,
            ...feed.queued,
            ...(feed.done.state === "ready" ? feed.done.rows : []),
          ].flatMap((row) => (row.ask ? [row.ask.authorPubkey] : [])),
        ]),
      ),
    [feed],
  );
  const profiles = useProfiles(pubkeys);
  const channels = context?.channels ?? [];
  const runningAgents = useMemo(
    () =>
      new Set(
        feed.running
          .filter((row) => row.state === "live" || row.state === "reacting")
          .map((row) => row.agentPubkey),
      ),
    [feed.running],
  );

  const toggle = (section: WorkSection) =>
    setCollapsed((previous) => {
      const next = { ...previous, [section]: !previous[section] };
      saveCollapsedSections(next);
      return next;
    });
  const chooseScope = (next: WorkScope) => saveWorkScope(next);

  const openRow = (row: NeedRow) => {
    if (row.source.kind === "mention") {
      context?.markInboxRead(row.source.item.messages);
    }
    if (!row.open) {
      return;
    }
    if ("view" in row.open) {
      onOpenView(row.open.view);
    } else {
      onOpenMessage(row.open.channelId, row.open.messageId);
    }
  };
  const ctx: NeedRowContext = {
    nowS,
    channels,
    profiles,
    agentPubkeys: context?.agentPubkeys ?? new Set(),
    runningAgents,
    selfPubkey: context?.selfPubkey ?? null,
    onOpen: openRow,
    onOpenView,
    onMarkRead: (row) => {
      if (row.source.kind === "mention") {
        context?.markInboxRead(row.source.item.messages);
      }
    },
  };

  const needs = (
    <NeedsYouSection
      needs={feed.needs}
      counts={feed.needCounts}
      ctx={ctx}
      collapsed={variant === "rail" && collapsed.needs}
      onToggle={() => toggle("needs")}
      size={variant}
      showHeader={variant === "rail"}
    />
  );
  const running = (
    <RunningSection
      rows={feed.running}
      nowS={nowS}
      channels={channels}
      profiles={profiles}
      collapsed={variant === "rail" && collapsed.running}
      onToggle={() => toggle("running")}
      onOpenChannel={onOpenChannel}
      onDismiss={(turnId) => context?.dismissTurn(turnId)}
      size={variant}
      showHeader={variant === "rail"}
    />
  );
  const queued = (
    <QueuedSection
      rows={feed.queued}
      nowS={nowS}
      channels={channels}
      profiles={profiles}
      collapsed={variant === "rail" && collapsed.queued}
      onToggle={() => toggle("queued")}
      onOpenMessage={onOpenMessage}
    />
  );
  const done = (
    <DoneSection
      done={feed.done}
      channels={channels}
      profiles={profiles}
      collapsed={collapsed.done}
      onToggle={() => toggle("done")}
      onOpenChannel={onOpenChannel}
    />
  );
  const scopeToggle = (
    <fieldset className="flex min-w-0 rounded-[9px] bg-chip p-0.5">
      <legend className="sr-only">Scope</legend>
      {(
        [
          ["everywhere", "Everywhere"],
          ["channel", "This channel"],
        ] as const
      ).map(([id, label]) => (
        <button
          key={id}
          type="button"
          aria-pressed={effectiveScope === id}
          disabled={id === "channel" && !channelId}
          onClick={() => chooseScope(id)}
          className={cn(
            "h-6.5 rounded-[7px] px-2.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50",
            effectiveScope === id
              ? "bg-card text-foreground shadow-xs"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {label}
        </button>
      ))}
    </fieldset>
  );

  if (variant === "page") {
    const chips: Array<[PhoneSection, string, number]> = [
      ["needs", "Needs you", feed.needCounts.all],
      ["running", "Running", feed.running.length],
      ["queued", "Queued", feed.queued.length],
    ];
    return (
      <div
        data-testid="work-page"
        className="flex h-full min-h-0 flex-col bg-rail text-foreground"
      >
        {/* The shell row already clears the top safe-area inset on tab pages. */}
        <header className="flex items-center gap-2 pt-4.5 pr-3 pb-1.5 pl-4.5">
          <h1 className="text-3xl font-bold tracking-tight">Work</h1>
          {onJump && (
            <button
              type="button"
              aria-label="Jump"
              onClick={onJump}
              className="ml-auto grid size-11 place-items-center rounded-xl text-ink-2 hover:bg-accent"
            >
              <Search aria-hidden className="size-5" />
            </button>
          )}
        </header>
        {vitals ? <div className="px-4 pt-1">{vitals}</div> : null}
        {channelId && (
          <div className="px-4 pt-2.5">
            <button
              type="button"
              data-testid="work-channel-scope"
              aria-label="Show work everywhere"
              onClick={onClearChannel}
              className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-full bg-honey-soft pr-2 pl-3 text-xs font-semibold text-honey-ink"
            >
              <span className="truncate">
                {channelLabel(channelId, channels) || "This channel"} only
              </span>
              <X aria-hidden className="size-3.5 shrink-0" />
            </button>
          </div>
        )}
        <div className="flex gap-1.5 overflow-x-auto px-4 pt-3 pb-2">
          {chips.map(([id, label, count]) => (
            <button
              key={id}
              type="button"
              aria-pressed={phoneSection === id}
              onClick={() => setPhoneSection(id)}
              className={cn(
                "h-8.5 shrink-0 whitespace-nowrap rounded-full px-3 text-sidebar-meta font-semibold",
                phoneSection === id
                  ? "bg-primary text-primary-foreground"
                  : "border border-border bg-card text-ink-2",
              )}
            >
              {label} {count}
            </button>
          ))}
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 pt-1 pb-4 *:shrink-0">
          {phoneSection === "needs" && needs}
          {phoneSection === "running" && (
            <>
              {running}
              {done}
            </>
          )}
          {phoneSection === "queued" &&
            (feed.queued.length > 0 ? (
              queued
            ) : (
              <p className="px-0.5 text-sm text-muted-foreground">
                Nothing is queued.
              </p>
            ))}
        </div>
      </div>
    );
  }

  return (
    <aside
      aria-label="Work"
      data-testid="work-rail"
      // A content pane, so the custom-gradient theme cards it like the
      // thread and thinking panes it shares the dock with.
      data-custom-content-pane="work"
      // `*:shrink-0`: once the sections overflow, a flex column would squeeze
      // the folded Queued / Done rows below their 34 px instead of scrolling.
      className="flex h-full min-h-0 w-full flex-col gap-3 overflow-y-auto bg-rail p-3.5 *:shrink-0"
    >
      <div className="flex items-center gap-2">
        {showTitle && (
          <h2 className="text-base font-bold tracking-tight">Work</h2>
        )}
        <div className="ml-auto flex items-center gap-1">
          {scopeToggle}
          {onCollapse && (
            <button
              type="button"
              aria-label="Collapse Work"
              onClick={onCollapse}
              className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <PanelRightClose aria-hidden className="size-4" />
            </button>
          )}
        </div>
      </div>
      {needs}
      {running}
      {queued}
      {done}
    </aside>
  );
}
