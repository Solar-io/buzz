import { Check } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import type { HerdrSnapshot } from "../lib/hatchClient.ts";
import type { HerdrView, StatusTone, TabChip } from "../lib/herdrView.ts";

/** A status dot: amber pulse running, coral needs you, hollow when quiet. */
export function StatusDot({
  tone,
  className,
}: {
  tone: StatusTone;
  className?: string;
}) {
  if (tone === "done") {
    return (
      <Check
        aria-hidden
        strokeWidth={2.6}
        className={cn("size-3 shrink-0 text-leaf", className)}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        "size-1.75 shrink-0 rounded-full",
        tone === "work" && "bg-work motion-safe:animate-pulse",
        tone === "need" && "bg-need",
        tone === "idle" && "border-[1.5px] border-faint",
        className,
      )}
    />
  );
}

const SECTION =
  "flex items-center justify-between px-1.5 pb-1 text-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground";

/**
 * herdr's spaces and agents (Terminal artboard, left rail). READ-ONLY: herdr
 * focus is server-global, so a click here would move Sam's CLI view of the
 * same session — rows are not buttons, and say how to switch instead.
 */
export function TerminalRail({
  view,
  snapshot,
  failed,
}: {
  view: HerdrView | null;
  snapshot: HerdrSnapshot | null;
  failed: boolean;
}) {
  return (
    <aside
      aria-label="herdr"
      data-testid="terminal-rail"
      className="flex w-57.5 shrink-0 flex-col gap-0.75 overflow-y-auto border-r border-border bg-rail px-2.5 py-3"
    >
      <div className={cn(SECTION, "pt-0.5")}>Spaces</div>
      <RailBody view={view} snapshot={snapshot} failed={failed} />
    </aside>
  );
}

function RailBody({
  view,
  snapshot,
  failed,
}: {
  view: HerdrView | null;
  snapshot: HerdrSnapshot | null;
  failed: boolean;
}) {
  if (!snapshot) {
    return (
      <p className="px-1.5 text-xs text-muted-foreground">
        {failed ? "Couldn't read herdr." : "Reading herdr…"}
      </p>
    );
  }
  if (!snapshot.running) {
    return (
      <p
        data-testid="herdr-stopped"
        className="px-1.5 text-xs leading-snug text-muted-foreground"
      >
        herdr isn't running on crichton. Opening the terminal starts it.
      </p>
    );
  }
  if (snapshot.unsupported || !view) {
    return (
      <p className="px-1.5 text-xs leading-snug text-muted-foreground">
        This herdr version isn't one Buzz can read. The terminal still works.
      </p>
    );
  }
  return (
    <>
      <ul className="flex flex-col gap-0.5">
        {view.spaces.map((space) => (
          <li
            key={space.id}
            data-testid="herdr-space"
            aria-current={space.focused ? "true" : undefined}
            className={cn(
              "flex h-7.5 items-center gap-2 rounded-[7px] px-2 text-sidebar-meta",
              space.focused
                ? "bg-card font-semibold text-foreground shadow-[0_0_0_1px_hsl(var(--border))]"
                : "text-ink-2",
            )}
          >
            <StatusDot tone={space.tone} />
            <span className="truncate">{space.label}</span>
          </li>
        ))}
      </ul>
      {view.agents.length > 0 ? (
        <>
          <div className={cn(SECTION, "pt-4")}>
            Agents
            <span className="font-mono font-medium normal-case tracking-normal">
              by space
            </span>
          </div>
          <ul className="flex flex-col gap-0.5">
            {view.agents.map((agent) => (
              <li
                key={agent.id}
                data-testid="herdr-agent"
                className={cn(
                  "flex gap-2 rounded-[7px] px-2 py-1.5",
                  agent.tone === "work" && "bg-sel",
                )}
              >
                <StatusDot tone={agent.tone} className="mt-1.5" />
                <span className="min-w-0">
                  <span className="block truncate text-xs text-ink-2">
                    <b className="font-semibold text-foreground">
                      {agent.space}
                    </b>
                    {" · "}
                    {agent.title}
                  </span>
                  <span
                    className={cn(
                      "block truncate font-mono text-2xs",
                      agent.tone === "need"
                        ? "text-coral-ink"
                        : "text-muted-foreground",
                    )}
                  >
                    {agent.meta}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <p className="mt-auto px-1.5 pt-4 font-mono text-2xs leading-relaxed text-faint">
        ⌘J / ⌘K in the terminal switch tabs
      </p>
    </>
  );
}

/**
 * The focused space's tabs (Terminal / PhoneTerminal artboards). A mirror of
 * herdr, not a control: herdr focus is server-global.
 */
export function TerminalTabs({
  tabs,
  variant,
}: {
  tabs: TabChip[];
  variant: "strip" | "chips";
}) {
  if (tabs.length === 0) {
    return null;
  }
  return (
    <ul
      aria-label="herdr tabs"
      data-testid="terminal-tabs"
      className={cn(
        "flex items-center font-mono text-xs",
        variant === "strip"
          ? "h-9 shrink-0 gap-0.5 border-b border-border bg-term-tab px-2"
          : "gap-1.5 overflow-x-auto px-3 pt-1 pb-2.5 [scrollbar-width:none]",
      )}
    >
      {tabs.map((tab) => (
        <li
          key={tab.id}
          aria-current={tab.focused ? "true" : undefined}
          data-testid="terminal-tab"
          className={cn(
            "inline-flex shrink-0 items-center gap-1.75 whitespace-nowrap",
            variant === "strip"
              ? cn(
                  "h-6.5 rounded-md px-3",
                  tab.focused
                    ? "bg-term text-term-ink shadow-[0_0_0_1px_hsl(var(--border))]"
                    : "text-term-dim",
                )
              : cn(
                  "h-8 rounded-lg px-3",
                  tab.focused
                    ? "bg-foreground text-background"
                    : "bg-chip text-ink-2",
                ),
          )}
        >
          {tab.tone === "work" || tab.tone === "need" ? (
            <StatusDot tone={tab.tone} className="size-1.5" />
          ) : null}
          {tab.label}
        </li>
      ))}
    </ul>
  );
}
