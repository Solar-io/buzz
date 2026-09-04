/**
 * Keyboard shortcuts — read-only, exactly like the desktop's card.
 *
 * The list is short on purpose: it names only the handlers this client
 * actually has. See `lib/keyboardShortcuts.ts` for where each one lives.
 */

import { SHORTCUT_CATEGORIES, keysFor } from "../lib/keyboardShortcuts.ts";

function platformString(): string {
  if (typeof navigator === "undefined") return "";
  return navigator.platform ?? "";
}

export function KeyboardShortcutsCard() {
  const platform = platformString();

  return (
    <section
      className="space-y-3 rounded-lg border border-border bg-card p-4"
      data-testid="keyboard-shortcuts-card"
    >
      <div>
        <h2 className="font-medium">Keyboard shortcuts</h2>
        <p className="text-sm text-muted-foreground">
          What Buzz listens for in this browser. Read-only.
        </p>
      </div>

      {SHORTCUT_CATEGORIES.map((category) => (
        <div key={category.name}>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground/70">
            {category.name}
          </p>
          <ul className="mt-1 divide-y divide-border">
            {category.shortcuts.map((shortcut) => (
              <li
                className="flex items-center justify-between gap-4 py-1.5"
                key={shortcut.id}
              >
                <span className="min-w-0">
                  <span className="text-sm font-medium">{shortcut.label}</span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {shortcut.description}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  {keysFor(shortcut, platform).map((key) => (
                    <kbd
                      className="inline-flex h-6 min-w-6 items-center justify-center rounded border border-border/70 bg-muted/60 px-1.5 font-mono text-xs text-muted-foreground"
                      key={key}
                    >
                      {key}
                    </kbd>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
