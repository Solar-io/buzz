import { useEffect, useState } from "react";
import { fetchSignedMedia } from "@/shared/api/blossom";
import { cn } from "@/shared/lib/cn";
import { avatarPaletteClass, getInitials } from "../lib/avatar.ts";

/**
 * Portrait-frame box: a short banner crop below lg (a full-height 3:4 photo
 * would push the transcript off a phone screen) and a true 3:4 frame at lg.
 */
const PORTRAIT_FRAME_CLASSES =
  "h-44 w-full rounded-xl border border-border object-cover lg:aspect-[3/4] lg:h-auto";

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
  shape = "circle",
}: {
  pubkey: string;
  label: string;
  picture?: string;
  size?: "sm" | "dm" | "md" | "md-sm";
  /**
   * "portrait" renders the same picture/fallback logic as a rectangular
   * hero frame (agent activity pane) instead of a circle; `size` is
   * ignored there — the frame is full-width and responsive.
   */
  shape?: "circle" | "portrait";
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
      ? "h-5 w-5 text-badge"
      : size === "dm"
        ? "h-6 w-6 text-badge"
        : size === "md-sm"
          ? "h-7 w-7 text-xs"
          : "h-9 w-9 text-sm";
  if (shape === "portrait") {
    if (objectUrl) {
      return <img src={objectUrl} alt="" className={PORTRAIT_FRAME_CLASSES} />;
    }
    // Same frame box, palette fill and initials as the circle fallback.
    return (
      <div
        data-pubkey={pubkey}
        className={cn(
          "flex select-none items-center justify-center font-semibold shadow-xs",
          PORTRAIT_FRAME_CLASSES,
          avatarPaletteClass(label),
        )}
      >
        {getInitials(label)}
      </div>
    );
  }
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
