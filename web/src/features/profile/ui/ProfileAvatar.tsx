import { useAvatarSrc } from "@/shared/hooks/useAvatarSrc";
import { cn } from "@/shared/lib/cn";
import {
  avatarPaletteClass,
  getInitials,
} from "@/features/channels/lib/avatar.ts";

/**
 * Profile avatar at an arbitrary size.
 *
 * `channels/ui/AuthorAvatar` covers the timeline's four fixed sizes; the
 * profile card and the full view need 40px and 64px discs, so this takes the
 * box classes from the caller. The two behaviours that must not diverge from
 * `AuthorAvatar` — relay media is auth-gated so the picture goes through the
 * signed fetch, and the fallback is the desktop's initials-on-palette
 * identicon — are shared rather than re-implemented: the palette and initials
 * rules come from `channels/lib/avatar.ts`, the same module `AuthorAvatar`
 * uses.
 */
export function ProfileAvatar({
  label,
  picture,
  className,
  testId,
}: {
  /** Display label — drives both the initials and the palette colour. */
  label: string;
  /** Avatar URL from kind 0, if published. */
  picture?: string;
  /** Box + text-size classes, e.g. `"h-10 w-10 text-sm"`. */
  className?: string;
  testId?: string;
}) {
  const { src: objectUrl, onError } = useAvatarSrc(picture);

  if (objectUrl) {
    return (
      <img
        alt=""
        className={cn("shrink-0 rounded-full object-cover", className)}
        data-testid={testId}
        src={objectUrl}
        onError={onError}
      />
    );
  }

  return (
    <div
      className={cn(
        "flex shrink-0 select-none items-center justify-center rounded-full font-semibold shadow-xs",
        avatarPaletteClass(label),
        className,
      )}
      data-testid={testId}
    >
      {getInitials(label)}
    </div>
  );
}
