import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

export interface ContextMenuItem {
  label: string;
  onSelect: () => void;
  /** Renders a destructive style (leave/delete). */
  danger?: boolean;
}

/**
 * Right-click / ⋯-click context menu, fixed-positioned and viewport-clamped.
 * Outside pointerdown or Esc closes. Items are a flat list — dividers can be
 * items with empty labels if ever needed.
 */
export function ContextMenu({
  items,
  children,
}: {
  items: ContextMenuItem[];
  /** Render prop for the anchor — call open() to show the menu there. */
  children: (open: (x: number, y: number) => void) => ReactNode;
}) {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(
    null,
  );
  const menuRef = useRef<HTMLDivElement>(null);
  const [adjusted, setAdjusted] = useState<{ x: number; y: number } | null>(
    null,
  );

  useEffect(() => {
    if (!position) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setPosition(null);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPosition(null);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [position]);

  // Clamp after mount so the menu's real size is measurable.
  useLayoutEffect(() => {
    if (!position) {
      setAdjusted(null);
      return;
    }
    const rect = menuRef.current?.getBoundingClientRect();
    const width = rect?.width ?? 160;
    const height = rect?.height ?? 120;
    setAdjusted({
      x: Math.max(8, Math.min(position.x, globalThis.innerWidth - width - 8)),
      y: Math.max(8, Math.min(position.y, globalThis.innerHeight - height - 8)),
    });
  }, [position]);

  return (
    <>
      {children((x, y) => setPosition({ x, y }))}
      {position && adjusted && (
        <div
          ref={menuRef}
          role="menu"
          className="fixed z-50 min-w-40 overflow-hidden rounded-md border border-border bg-popover py-1 shadow-lg"
          style={{ left: adjusted.x, top: adjusted.y }}
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={
                item.danger
                  ? "block w-full px-3 py-1.5 text-left text-sm text-red-400 hover:bg-accent"
                  : "block w-full px-3 py-1.5 text-left text-sm hover:bg-accent"
              }
              onClick={() => {
                setPosition(null);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
