import { cloneElement, type ReactElement } from "react";
import { cn } from "@/shared/lib/cn";
import { mosaicLayout } from "../lib/messageMedia.ts";
import type { MessageMediaProps } from "./MessageMedia.tsx";

/**
 * Grid layout for a message whose paragraph is nothing but images — the web
 * mirror of the desktop's `shared/ui/markdown/ImageMosaic.tsx`.
 *
 * Two images split a row, three form a hero-and-stack triptych, and larger
 * odd counts let the final image span both columns. The shape decision lives
 * in `mosaicLayout` (pure, unit-tested); this component only maps it onto
 * Tailwind classes and hands each tile its geometry.
 *
 * Tiles are told they are in a mosaic via a cloned prop rather than a CSS
 * override: the media frame sizes itself from the NIP-92 `dim` with an inline
 * style, and inline styles cannot be beaten by a class.
 */
export function ImageMosaic({
  children,
}: {
  children: ReactElement<MessageMediaProps>[];
}) {
  const layout = mosaicLayout(children.length);
  if (!layout) {
    return <>{children}</>;
  }

  return (
    <div
      data-image-mosaic=""
      data-image-mosaic-count={children.length}
      className={cn(
        "mt-1 grid w-full min-w-0 max-w-lg grid-cols-2 gap-1.5 overflow-hidden rounded-2xl",
        layout.fixedHeight && "h-80 grid-rows-2",
      )}
    >
      {children.map((child, index) => (
        <div
          // react-markdown children carry no stable ids, and the array is
          // static for a given message body.
          // biome-ignore lint/suspicious/noArrayIndexKey: see comment above
          key={index}
          className={cn(
            "min-w-0 overflow-hidden",
            layout.fixedHeight ? "h-full" : "h-48",
            index === layout.rowSpanIndex && "row-span-2",
            index === layout.colSpanIndex && "col-span-2",
          )}
        >
          {cloneElement(child, { mosaic: true })}
        </div>
      ))}
    </div>
  );
}
