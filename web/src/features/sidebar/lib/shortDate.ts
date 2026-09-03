/** Compact date for huddle entries: "Aug 29". */
export function shortDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
}
