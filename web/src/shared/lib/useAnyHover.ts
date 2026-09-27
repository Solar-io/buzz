import { useEffect, useState } from "react";

/**
 * Same query as `globals.css` (commit 3d2fb94d7): true when ANY attached
 * pointer can hover, so an iPad with a trackpad counts. False when
 * `matchMedia` is absent.
 */
export const ANY_HOVER_QUERY = "(any-hover: hover)";

function currentAnyHover(): boolean {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function"
    ? window.matchMedia(ANY_HOVER_QUERY).matches
    : false;
}

/** Live `(any-hover: hover)`; follows attach/detach of a trackpad or mouse. */
export function useAnyHover(): boolean {
  const [anyHover, setAnyHover] = useState(currentAnyHover);
  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return;
    }
    const query = window.matchMedia(ANY_HOVER_QUERY);
    const onChange = () => setAnyHover(query.matches);
    onChange();
    query.addEventListener?.("change", onChange);
    return () => query.removeEventListener?.("change", onChange);
  }, []);
  return anyHover;
}
