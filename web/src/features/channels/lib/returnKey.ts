/**
 * Whether Return should insert a newline instead of sending. Only on a phone:
 * a touch-first device narrower than a tablet. An iPad also reports
 * `pointer: coarse`, but Sam types there like a desktop (often on a hardware
 * keyboard) and expects Return to send (2026-09-24). Shift+Return still adds a
 * newline everywhere.
 */
export const PHONE_RETURN_QUERY = "(pointer: coarse) and (max-width: 767px)";

export function returnInsertsNewline(
  matchMedia: ((query: string) => { matches: boolean }) | undefined,
): boolean {
  return matchMedia?.(PHONE_RETURN_QUERY).matches ?? false;
}
