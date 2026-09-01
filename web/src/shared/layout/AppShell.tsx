import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

/**
 * Two-pane responsive shell: sidebar + main. On small screens the sidebar
 * becomes an overlay drawer behind a top bar (iOS/iPadOS friendly: it uses
 * dvh sizing and safe-area padding). At desktop widths both panes are
 * drag-resizable via edge handles (persisted per device).
 */

/**
 * Closes the mobile drawer when invoked. Sidebar navigation entries call this
 * after navigating so phone users land on the conversation, not the drawer.
 * No-op on desktop (and when the drawer is already closed).
 */
const DrawerCloseContext = createContext<() => void>(() => {});

export function useDrawerClose(): () => void {
  return useContext(DrawerCloseContext);
}

const SIDEBAR_WIDTH_KEY = "buzz.sidebar-width.v1";
const DEFAULT_SIDEBAR_WIDTH = 232;
const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 480;

function loadSidebarWidth(): number {
  const stored = Number.parseFloat(
    globalThis.localStorage?.getItem(SIDEBAR_WIDTH_KEY) ?? "",
  );
  if (
    Number.isFinite(stored) &&
    stored >= MIN_SIDEBAR_WIDTH &&
    stored <= MAX_SIDEBAR_WIDTH
  ) {
    return stored;
  }
  return DEFAULT_SIDEBAR_WIDTH;
}

/**
 * Pointer-driven column resize handle. Dragging adjusts `width` via the
 * setter; `persist` fires on release (and after settling) so localStorage
 * writes don't happen sixty times a second.
 */
function ResizeHandle({
  orientation,
  onDrag,
  onRelease,
  label,
}: {
  /** "left" = pane's left edge (drag left grows), "right" = right edge. */
  orientation: "left" | "right";
  onDrag: (deltaX: number) => void;
  onRelease: () => void;
  label: string;
}) {
  return (
    // biome-ignore lint/a11y/useFocusableInteractive: pointer-only resize handle; keyboard resize is not implemented
    // biome-ignore lint/a11y/useSemanticElements: pointer-only resize handle; keyboard resize is not implemented
    <div
      aria-label={label}
      // biome-ignore lint/a11y/useAriaPropsForRole: drag handle is not a value slider; aria-valuenow would be meaningless
      role="separator"
      aria-orientation="vertical"
      className={
        "group relative z-10 hidden w-1 shrink-0 cursor-col-resize border-sidebar-border bg-transparent transition-colors hover:bg-white/15 active:bg-white/25 md:block " +
        (orientation === "right" ? " -mr-px border-r" : " -ml-px border-l")
      }
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          onDrag(orientation === "right" ? event.movementX : -event.movementX);
        }
      }}
      onPointerUp={(event) => {
        event.currentTarget.releasePointerCapture(event.pointerId);
        onRelease();
      }}
    />
  );
}

export function AppShell({
  sidebar,
  title,
  children,
}: {
  sidebar: ReactNode;
  /** Current conversation label for the mobile top bar. */
  title?: string | null;
  children: ReactNode;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const closeDrawer = () => setDrawerOpen(false);
  const [sidebarWidth, setSidebarWidth] = useState<number>(() =>
    loadSidebarWidth(),
  );

  useEffect(() => {
    globalThis.localStorage?.setItem(
      SIDEBAR_WIDTH_KEY,
      String(Math.round(sidebarWidth)),
    );
  }, [sidebarWidth]);

  const clampSidebar = useCallback((width: number) => {
    setSidebarWidth(
      Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width)),
    );
  }, []);

  return (
    <div className="flex h-dvh w-full bg-background text-foreground">
      {/* Desktop sidebar — its own tone (theme --sidebar-background), matching
          the desktop client's deliberate sidebar/chat two-tone. Width is
          drag-adjustable; the handle doubles as the border. */}
      <aside
        className="hidden shrink-0 flex-col bg-sidebar text-sidebar-foreground md:flex"
        style={{ width: `${sidebarWidth}px` }}
      >
        {sidebar}
      </aside>
      <ResizeHandle
        orientation="right"
        label="Resize channel sidebar"
        onDrag={(delta) => clampSidebar(sidebarWidth + delta)}
        onRelease={() => clampSidebar(sidebarWidth)}
      />

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
              role="img"
              aria-label="Menu"
            >
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <span className="min-w-0 truncate">
            {title ? (
              <>
                <span className="text-muted-foreground">Buzz</span>
                <span className="mx-1.5 text-muted-foreground">/</span>
                <span className="font-semibold">{title}</span>
              </>
            ) : (
              <span className="font-semibold">Buzz</span>
            )}
          </span>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>

      {drawerOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <button
            type="button"
            aria-label="Close channels"
            className="absolute inset-0 bg-black/50"
            onClick={closeDrawer}
          />
          <aside className="absolute top-0 bottom-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground pt-[max(0.5rem,env(safe-area-inset-top))]">
            <DrawerCloseContext.Provider value={closeDrawer}>
              {sidebar}
            </DrawerCloseContext.Provider>
          </aside>
        </div>
      )}
    </div>
  );
}
