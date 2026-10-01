import { useEffect, useState } from "react";

/** The breakpoint the right pane docks at (Tailwind `lg`). */
export const DOCK_QUERY = "(min-width: 64rem)";

/**
 * True at `lg` and up, where the right pane is a docked column; below it a
 * file opens as a full-screen sheet. A JS decision rather than two CSS-hidden
 * copies, because a preview is not free to mount twice — an HTML file would
 * run its scripts in both.
 */
export function useDockedPane(): boolean {
  const [docked, setDocked] = useState(
    () => globalThis.matchMedia?.(DOCK_QUERY).matches ?? true,
  );
  useEffect(() => {
    const query = globalThis.matchMedia?.(DOCK_QUERY);
    if (!query) {
      return;
    }
    const onChange = () => setDocked(query.matches);
    onChange();
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return docked;
}
