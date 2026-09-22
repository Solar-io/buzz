import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  PANE_RESIZE_HANDLE_CLASSES,
  usePointerDrag,
} from "./usePointerDrag.ts";

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

/**
 * The phone bar's right-hand slot (Sam, 2026-09-22): the conversation's
 * controls (mic, call, thinking, threads) portal here below `md` so the
 * composer row under the text box gets its height back. Null until the bar
 * mounts, and always null at `md`+ where the bar is hidden.
 */
const PhoneBarSlotContext = createContext<HTMLElement | null>(null);

export function usePhoneBarSlot(): HTMLElement | null {
  return useContext(PhoneBarSlotContext);
}

/** Below `md` — the widths where the phone bar shows (`md:hidden`). */
const PHONE_QUERY = "(max-width: 767px)";

export function usePhoneLayout(): boolean {
  const [phone, setPhone] = useState(
    () => globalThis.matchMedia?.(PHONE_QUERY).matches ?? false,
  );
  useEffect(() => {
    const query = globalThis.matchMedia?.(PHONE_QUERY);
    if (!query) return;
    const onChange = () => setPhone(query.matches);
    onChange();
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return phone;
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
  const drag = usePointerDrag({
    onDrag: (deltaX) => onDrag(orientation === "right" ? deltaX : -deltaX),
    onRelease,
  });
  return (
    // biome-ignore lint/a11y/useFocusableInteractive: pointer-only resize handle; keyboard resize is not implemented
    // biome-ignore lint/a11y/useSemanticElements: pointer-only resize handle; keyboard resize is not implemented
    <div
      aria-label={label}
      // biome-ignore lint/a11y/useAriaPropsForRole: drag handle is not a value slider; aria-valuenow would be meaningless
      role="separator"
      aria-orientation="vertical"
      className={
        `group relative z-10 hidden w-1 shrink-0 cursor-col-resize border-sidebar-border bg-transparent transition-colors hover:bg-white/15 active:bg-white/25 md:block ${PANE_RESIZE_HANDLE_CLASSES}` +
        (orientation === "right" ? " -mr-px border-r" : " -ml-px border-l")
      }
      {...drag}
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
  const [phoneBarSlot, setPhoneBarSlot] = useState<HTMLDivElement | null>(null);
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
    <div className="buzz-app-shell flex h-dvh w-full bg-background text-foreground">
      {/* Desktop sidebar — its own tone (theme --sidebar-background), matching
          the desktop client's deliberate sidebar/chat two-tone. Width is
          drag-adjustable; the handle doubles as the border. */}
      <aside
        className="buzz-shell-navigation hidden shrink-0 flex-col bg-sidebar text-sidebar-foreground md:flex"
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
        {/* Phone bar (Sam, 2026-09-22): ONE gray bar — the hamburger and the
            conversation name, where the old channel header sat. The
            "Buzz / Name" breadcrumb bar above it is gone. */}
        <header className="buzz-shell-navigation flex min-h-11 shrink-0 items-center gap-1 border-b border-border bg-secondary px-2 py-1 pt-[max(0.25rem,env(safe-area-inset-top))] md:hidden">
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
          <span className="min-w-0 flex-1 truncate font-semibold">
            {title || "Buzz"}
          </span>
          <div
            ref={setPhoneBarSlot}
            data-testid="phone-bar-actions"
            className="flex shrink-0 items-center"
          />
        </header>
        <main className="buzz-content-scrollbar min-h-0 flex-1 overflow-y-auto">
          <PhoneBarSlotContext.Provider value={phoneBarSlot}>
            {children}
          </PhoneBarSlotContext.Provider>
        </main>
      </div>

      {drawerOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <button
            type="button"
            aria-label="Close channels"
            className="absolute inset-0 bg-black/50"
            onClick={closeDrawer}
          />
          <aside className="buzz-shell-navigation absolute top-0 bottom-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground pt-[max(0.5rem,env(safe-area-inset-top))]">
            <DrawerCloseContext.Provider value={closeDrawer}>
              {sidebar}
            </DrawerCloseContext.Provider>
          </aside>
        </div>
      )}
    </div>
  );
}
