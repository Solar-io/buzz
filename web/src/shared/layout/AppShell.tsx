import { useState, type ReactNode } from "react";

/**
 * Two-pane responsive shell: sidebar + main. On small screens the sidebar
 * becomes an overlay drawer behind a top bar (iOS/iPadOS friendly: it uses
 * dvh sizing and safe-area padding).
 */
export function AppShell({
  sidebar,
  children,
}: {
  sidebar: ReactNode;
  children: ReactNode;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div className="flex h-dvh w-full bg-background text-foreground">
      {/* Desktop sidebar */}
      <aside className="hidden w-72 shrink-0 flex-col border-r border-border md:flex">
        {sidebar}
      </aside>

      {/* Mobile top bar + drawer */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-border px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-[max(0.5rem,env(safe-area-inset-top))] md:hidden">
          <button
            type="button"
            aria-label="Open channels"
            className="rounded-md p-2 hover:bg-accent"
            onClick={() => setDrawerOpen(true)}
          >
            <svg
              viewBox="0 0 24 24"
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <span className="font-semibold">Buzz</span>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>

      {drawerOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <button
            type="button"
            aria-label="Close channels"
            className="absolute inset-0 bg-black/50"
            onClick={() => setDrawerOpen(false)}
          />
          <aside className="absolute top-0 bottom-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-border bg-background pt-[max(0.5rem,env(safe-area-inset-top))]">
            {sidebar}
          </aside>
        </div>
      )}
    </div>
  );
}
