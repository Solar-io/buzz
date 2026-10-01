import { Check } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import type { StatusTone, TabChip } from "../lib/herdrView.ts";

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
