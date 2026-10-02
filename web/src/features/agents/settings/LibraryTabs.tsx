/** Library navigation stays inside the Settings shell. */
export const LIBRARY_TABS = [
  "definitions",
  "teams",
  "catalog",
  "snapshots",
] as const;
export type LibraryTab = (typeof LIBRARY_TABS)[number];

export function LibraryTabs({
  value,
  onChange,
}: {
  value: LibraryTab;
  onChange: (tab: LibraryTab) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Agent library"
      className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1 sm:grid-cols-4"
    >
      {LIBRARY_TABS.map((tab) => (
        <button
          key={tab}
          type="button"
          role="tab"
          id={`library-tab-${tab}`}
          aria-selected={value === tab}
          aria-controls="library-panel"
          tabIndex={value === tab ? 0 : -1}
          className={`min-h-11 rounded-md px-3 text-sm capitalize focus-visible:ring-2 focus-visible:ring-ring ${value === tab ? "bg-card text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"}`}
          onClick={() => onChange(tab)}
          onKeyDown={(event) => {
            const index = LIBRARY_TABS.indexOf(tab);
            const next =
              event.key === "ArrowRight"
                ? (index + 1) % 4
                : event.key === "ArrowLeft"
                  ? (index + 3) % 4
                  : event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? 3
                      : null;
            if (next === null) return;
            event.preventDefault();
            onChange(LIBRARY_TABS[next]);
            document
              .getElementById(`library-tab-${LIBRARY_TABS[next]}`)
              ?.focus();
          }}
        >
          {tab[0].toUpperCase() + tab.slice(1)}
        </button>
      ))}
    </div>
  );
}
