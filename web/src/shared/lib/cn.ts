import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * The app's own font-size tokens — every key of `fontSize` in
 * `tailwind.config.js` (`cn.test.mjs` pins the two lists together).
 *
 * tailwind-merge only knows t-shirt sizes, so out of the box it read
 * `text-sidebar-meta` as a COLOUR: `cn("text-sidebar-meta", "text-foreground")`
 * kept the colour and silently dropped the size, and the text fell back to
 * whatever it inherited (seen on the command list, 2026-09-30: 16px
 * descriptions under 12px names). Declaring them as sizes makes two sizes
 * conflict — the later wins, as with stock sizes — and a size and a colour
 * coexist.
 */
export const CUSTOM_FONT_SIZES = [
  "2xs",
  "3xs",
  "badge",
  "sidebar-meta",
  "message",
  "message-timestamp",
  "title",
  "nsec-key",
] as const;

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: [...CUSTOM_FONT_SIZES] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
