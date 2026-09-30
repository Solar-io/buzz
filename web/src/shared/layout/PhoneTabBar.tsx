import { Hash, ListTodo, MoreHorizontal } from "lucide-react";
import { type ReactNode, useState } from "react";

import { cn } from "@/shared/lib/cn";
import { Sheet, SheetContent, SheetTitle } from "@/shared/ui/sheet";
import type { PhoneTab } from "./phoneTabs.ts";

export interface PhoneMoreItem {
  label: string;
  icon: ReactNode;
  onSelect: () => void;
}

function Badge({ count, tone }: { count: number; tone: "need" | "ink" }) {
  if (count <= 0) {
    return null;
  }
  return (
    <span
      className={cn(
        "absolute top-0 left-[56%] flex h-4.5 min-w-4.5 items-center justify-center rounded-full px-1.25 font-mono text-2xs font-semibold leading-none",
        tone === "need"
          ? "bg-need text-need-foreground"
          : "bg-primary text-primary-foreground",
      )}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

/**
 * The phone's bottom tab bar (PhoneWork artboard; phase-1 §6): Work,
 * Channels, More. Items (Phase 5) lives in More; Shelf joins as its phase
 * ships — an entry appears only once its page exists.
 *
 * Rendered by AppShell below the content row (not fixed over it), so nothing
 * is ever hidden behind the bar; the bottom padding is the home indicator.
 */
export function PhoneTabBar({
  active,
  needs,
  unread,
  onWork,
  onChannels,
  more,
}: {
  active: PhoneTab;
  /** Needs-you count — the Work tab's badge. */
  needs: number;
  /** Unread conversations — the Channels tab's badge. */
  unread: number;
  onWork: () => void;
  onChannels: () => void;
  more: PhoneMoreItem[];
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const tab = (
    id: PhoneTab,
    label: string,
    icon: ReactNode,
    onSelect: () => void,
    badge?: ReactNode,
  ) => (
    <button
      type="button"
      aria-current={active === id ? "page" : undefined}
      onClick={onSelect}
      className={cn(
        "relative flex min-h-12 flex-col items-center justify-center gap-0.75 text-2xs",
        active === id
          ? "font-semibold text-foreground"
          : "font-medium text-muted-foreground",
      )}
    >
      {icon}
      {label}
      {badge}
    </button>
  );
  return (
    <>
      <nav
        aria-label="Sections"
        data-testid="phone-tab-bar"
        className="grid grid-cols-3 border-t border-border bg-card px-1.5 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
      >
        {tab(
          "work",
          "Work",
          <ListTodo aria-hidden className="size-5.5" />,
          onWork,
          <Badge count={needs} tone="need" />,
        )}
        {tab(
          "channels",
          "Channels",
          <Hash aria-hidden className="size-5.5" />,
          onChannels,
          <Badge count={unread} tone="ink" />,
        )}
        {tab(
          "more",
          "More",
          <MoreHorizontal aria-hidden className="size-5.5" />,
          () => setMoreOpen(true),
        )}
      </nav>
      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent
          aria-describedby={undefined}
          data-testid="phone-more-sheet"
          onDismiss={() => setMoreOpen(false)}
        >
          <SheetTitle className="px-3 pb-1 text-muted-foreground">
            More
          </SheetTitle>
          <ul className="flex flex-col">
            {more.map((item) => (
              <li key={item.label}>
                <button
                  type="button"
                  onClick={() => {
                    setMoreOpen(false);
                    item.onSelect();
                  }}
                  className="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-base hover:bg-accent"
                >
                  <span className="text-ink-2">{item.icon}</span>
                  {item.label}
                </button>
              </li>
            ))}
          </ul>
        </SheetContent>
      </Sheet>
    </>
  );
}
