import { useEffect, useState } from "react";
import { fetchSignedMedia } from "@/shared/api/blossom";
import { cn } from "@/shared/lib/cn";
import { avatarPaletteClass, getInitials } from "../lib/avatar.ts";

/**
 * Author avatar: the profile picture when one is published (relay media is
 * auth-gated, so it goes through the signed fetch), else an initials circle
 * in the desktop client's identicon style — real word initials on one of the
 * desktop's seven palette classes (see `lib/avatar.ts`).
 *
 * Lives here rather than in ChannelTimeline because the sidebar DM rows, the
 * agent roster and the huddle bar all render it; ChannelTimeline re-exports
 * it so those import paths keep working.
 */
export function AuthorAvatar({
  pubkey,
  label,
  picture,
  size = "md",
}: {
  pubkey: string;
  label: string;
  picture?: string;
  size?: "sm" | "dm" | "md" | "md-sm";
}) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setObjectUrl(null);
    if (!picture) {
      return;
    }
    fetchSignedMedia(picture)
      .then((url) => {
        if (!cancelled) {
          setObjectUrl(url);
        }
      })
      .catch(() => {
        // Unavailable media falls back to the identicon below.
      });
    return () => {
      cancelled = true;
    };
  }, [picture]);
  // Sizes are unchanged from the pre-refactor component; the web theme has no
  // 2xs/3xs type tokens, so the desktop's exact ramp is not available here.
  const box =
    size === "sm"
      ? "h-5 w-5 text-[10px]"
      : size === "dm"
        ? "h-6 w-6 text-[10px]"
        : size === "md-sm"
          ? "h-7 w-7 text-xs"
          : "h-9 w-9 text-sm";
  if (objectUrl) {
    return (
      <img
        src={objectUrl}
        alt=""
        className={cn("rounded-full object-cover", box)}
      />
    );
  }
  // The DM rail keeps its own `dm-identicon` treatment (a globals.css class
  // that tints against the sidebar surface); everywhere else takes a palette
  // class. `pubkey` is still the stable identity for callers/tests even
  // though the color hashes the label, matching the desktop.
  const isDm = size === "dm";
  return (
    <div
      data-pubkey={pubkey}
      className={cn(
        "flex select-none items-center justify-center rounded-full font-semibold shadow-xs",
        box,
        isDm ? "dm-identicon" : avatarPaletteClass(label),
      )}
    >
      {getInitials(label)}
    </div>
  );
}
