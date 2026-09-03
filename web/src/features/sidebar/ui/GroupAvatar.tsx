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
    // B-target palette (dm-list-diff.md): #191926 fill, #C5CFF2 numeral;
    // 11px semibold per the desktop source (text-2xs).
    return (
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-[#191926] text-[11px] font-semibold leading-none text-[#C5CFF2]">
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
