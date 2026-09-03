/** Props for {@link GroupAvatar}. */
export interface GroupAvatarProps {
  count: number;
  /** Renders the DM-list variant (B-target palette) instead of the default. */
  dm?: boolean;
}

/**
 * Group-DM avatar placeholder (mock 2026-09-02): dark rounded square with
 * the member count, matching AuthorAvatar's md box so rows stay aligned.
 */
export function GroupAvatar({ count, dm }: GroupAvatarProps) {
  if (dm) {
    // Theme tokens, matching the desktop's group avatar. These were
    // sampled literals (#191926 / #C5CFF2) that ignored the active theme.
    // 11px semibold per the desktop source (text-2xs).
    return (
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-sidebar-accent text-2xs font-semibold leading-none text-sidebar-accent-foreground">
        <span className="translate-x-px leading-none">{count}</span>
      </span>
    );
  }
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted text-xs font-bold text-foreground">
      {count}
    </span>
  );
}
