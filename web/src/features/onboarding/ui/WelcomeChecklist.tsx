/**
 * The first-run checklist.
 *
 * Deliberately not a wizard. Desktop can block on its onboarding because it
 * owns the window; a web client that refused to show the app until you filled
 * in a form would be worse than the problem. So every item here links to where
 * the thing actually lives, and the whole panel is dismissible — except while
 * the key is unbacked, which is the one state that ends with a lost identity.
 */

import { Check, CircleAlert, X } from "lucide-react";
import { Link } from "@tanstack/react-router";

import { Button } from "@/shared/ui/button";
import { cn } from "@/shared/lib/cn";

import type {
  ChecklistItem,
  ChecklistItemId,
} from "../lib/onboardingChecklist.ts";
import { useOnboardingChecklist } from "../useOnboardingChecklist";

/** Where each item sends you. Settings is one route; the rest are panes. */
const DESTINATIONS: Record<ChecklistItemId, { to: string; search?: object }> = {
  profile: { to: "/repos/settings" },
  backup: { to: "/repos/settings" },
  notifications: { to: "/repos/settings" },
  theme: { to: "/repos/settings" },
  channel: { to: "/repos" },
};

function Row({ item }: { item: ChecklistItem }) {
  const destination = DESTINATIONS[item.id];
  return (
    <li
      className={cn(
        "flex items-start gap-3 rounded-md border p-3",
        item.done
          ? "border-border/60 bg-muted/30"
          : item.critical
            ? "border-amber-500/40"
            : "border-border",
      )}
      data-testid={`checklist-item-${item.id}`}
    >
      <span className="mt-0.5 shrink-0">
        {item.done ? (
          <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
        ) : item.critical ? (
          <CircleAlert className="h-4 w-4 text-amber-600 dark:text-amber-400" />
        ) : (
          <span className="block h-4 w-4 rounded-full border border-muted-foreground/40" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "text-sm font-medium",
            item.done && "text-muted-foreground line-through",
          )}
        >
          {item.title}
        </p>
        {item.done ? null : (
          <p className="mt-0.5 text-sm text-muted-foreground">{item.body}</p>
        )}
      </div>
      {item.done ? null : (
        <Button asChild size="sm" variant="outline">
          <Link to={destination.to}>{item.action}</Link>
        </Button>
      )}
    </li>
  );
}

/**
 * The full pane. `showWhenSettled` lets Settings render it as a permanent
 * section (where seeing a finished checklist is useful) while the shell pane
 * hides itself once there is nothing left to do.
 */
export function WelcomeChecklist({
  showWhenSettled = false,
}: {
  showWhenSettled?: boolean;
}) {
  const { dismiss, dismissed, items, progress, restore, visible } =
    useOnboardingChecklist();

  if (!visible && !showWhenSettled) return null;

  return (
    <section
      className="space-y-3 rounded-lg border border-border bg-card p-4"
      data-testid="welcome-checklist"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-medium">Getting set up</h2>
          <p className="text-sm text-muted-foreground">
            {progress.done} of {progress.total} done
            {progress.hasOutstandingCritical
              ? " — one of these protects your identity"
              : ""}
          </p>
        </div>
        {progress.hasOutstandingCritical ? null : dismissed ? (
          <Button onClick={restore} size="sm" variant="ghost">
            Show again
          </Button>
        ) : (
          <Button
            aria-label="Dismiss the setup checklist"
            onClick={dismiss}
            size="sm"
            variant="ghost"
          >
            <X className="mr-1 h-3.5 w-3.5" />
            Dismiss
          </Button>
        )}
      </div>

      <ul className="space-y-2">
        {items.map((item) => (
          <Row item={item} key={item.id} />
        ))}
      </ul>

      {progress.hasOutstandingCritical ? (
        <p className="text-xs text-muted-foreground/70">
          This panel keeps itself open until your key is backed up — that is the
          one step nothing else can undo for you.
        </p>
      ) : null}
    </section>
  );
}

/** Standalone pane wrapper for the shell's `?view=onboarding`. */
export function OnboardingPane() {
  return (
    <div
      className="mx-auto max-w-2xl space-y-4 p-4"
      data-testid="onboarding-pane"
    >
      <div>
        <h1 className="text-lg font-semibold">Welcome to Buzz</h1>
        <p className="text-sm text-muted-foreground">
          A few things worth doing once. Nothing here blocks you — close the
          pane whenever you like.
        </p>
      </div>
      <WelcomeChecklist showWhenSettled />
    </div>
  );
}
