import { useEffect, useRef } from "react";

/** ⌘K / Ctrl+K opens the jump panel, from anywhere in the shell. */
export function useJumpShortcut(open: () => void) {
  const latest = useRef(open);
  latest.current = open;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        latest.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
