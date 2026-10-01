import { useEffect, useState } from "react";

export function useMediaQuery(query: string, fallback = true): boolean {
  const [matches, setMatches] = useState(
    () => globalThis.matchMedia?.(query).matches ?? fallback,
  );
  useEffect(() => {
    const list = globalThis.matchMedia?.(query);
    if (!list) {
      return;
    }
    const onChange = () => setMatches(list.matches);
    onChange();
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/** Below this, a visualViewport shrink is URL-bar chrome, not a keyboard. */
const KEYBOARD_MIN_PX = 100;

/**
 * How many px of the layout viewport the on-screen keyboard covers (evie-ui
 * term-pad.js keyboard inset). iOS overlays the keyboard instead of resizing
 * the page, so the phone terminal pads its bottom by this much: the key bar
 * docks on the keyboard and the prompt stays above it. One resize when the
 * keyboard opens and one when it closes — never per frame.
 */
export function useKeyboardInset(enabled: boolean): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = globalThis.visualViewport;
    if (!enabled || !vv) {
      setInset(0);
      return;
    }
    let queued = false;
    const sync = () => {
      queued = false;
      const occluded = Math.max(
        0,
        Math.round(window.innerHeight - (vv.height + vv.offsetTop)),
      );
      setInset(occluded > KEYBOARD_MIN_PX ? occluded : 0);
    };
    const queue = () => {
      if (!queued) {
        queued = true;
        requestAnimationFrame(sync);
      }
    };
    vv.addEventListener("resize", queue);
    vv.addEventListener("scroll", queue);
    sync();
    return () => {
      vv.removeEventListener("resize", queue);
      vv.removeEventListener("scroll", queue);
    };
  }, [enabled]);
  return inset;
}
