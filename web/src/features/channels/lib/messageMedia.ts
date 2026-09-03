/**
 * Pure media-layout logic for message attachments — the web mirror of the
 * desktop's `shared/ui/markdown/utils.ts` (dimension + reserve box),
 * `ImageMosaic.tsx` (grid rules) and `markdownFileCard.ts` (file-card
 * classification).
 *
 * Everything here is import-free of React and of the DOM so the node runner
 * can load it directly. The components in `../ui/` map these structural
 * decisions onto Tailwind classes; keeping the decisions here is what makes
 * "three images form a hero-and-stack triptych" a testable claim rather than
 * an unverifiable class string.
 */

import type { ImetaEntry } from "./imetaEntries.ts";

export interface MediaDimensions {
  width: number;
  height: number;
}

/**
 * Inline display caps, matching the desktop's ProgressiveImage frame
 * (`Math.min(1, 384 / width, 256 / height)`). An image is scaled down to fit
 * inside this box; it is never scaled up.
 */
export const MEDIA_MAX_WIDTH = 384;
export const MEDIA_MAX_HEIGHT = 256;

/**
 * Box reserved for an image whose real size is unknown (no NIP-92 `dim`).
 * The desktop reserves the same 384x256 so a late decode letterboxes inside a
 * stable box instead of growing the row.
 */
export const DEFAULT_MEDIA_RESERVE: MediaDimensions = {
  width: MEDIA_MAX_WIDTH,
  height: MEDIA_MAX_HEIGHT,
};

/**
 * Parse a NIP-92 `dim` field ("1200x800"). Anything that is not two positive
 * integers separated by `x` is rejected rather than coerced — a wrong box is
 * worse than no box, because it reflows *after* the image decodes.
 */
export function dimensionsFromDim(dim?: string): MediaDimensions | undefined {
  if (!dim) {
    return undefined;
  }
  const match = /^(\d+)x(\d+)$/i.exec(dim);
  if (!match) {
    return undefined;
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return undefined;
  }
  return { width, height };
}

export interface MediaFrame {
  /** CSS `aspect-ratio` value, e.g. "1200 / 800". */
  aspectRatio: string;
  /** Rendered width in CSS pixels (already capped). */
  width: number;
  /** True when the size was assumed, not read from imeta. */
  reserved: boolean;
}

/**
 * Resolve the layout box for an attachment before its bytes arrive.
 *
 * This is the whole anti-reflow mechanism: the frame is sized from the
 * NIP-92 `dim` at first paint, so the surrounding text never moves when the
 * image finishes loading. Without a `dim` the frame falls back to a fixed
 * reserve box and the image letterboxes inside it (`object-contain`), which
 * also does not move — it is only ever wrong about empty space, never about
 * the row's height.
 */
export function mediaFrame(dim?: string): MediaFrame {
  const known = dimensionsFromDim(dim);
  const { width, height } = known ?? DEFAULT_MEDIA_RESERVE;
  const scale = Math.min(1, MEDIA_MAX_WIDTH / width, MEDIA_MAX_HEIGHT / height);
  return {
    aspectRatio: `${width} / ${height}`,
    width: Math.max(1, Math.round(width * scale)),
    reserved: known === undefined,
  };
}

export type MosaicShape = "pair" | "triptych" | "grid";

export interface MosaicLayout {
  shape: MosaicShape;
  /** Tile index that spans both grid rows (the triptych hero), else null. */
  rowSpanIndex: number | null;
  /** Tile index that spans both columns (the odd tail), else null. */
  colSpanIndex: number | null;
  /**
   * True when the mosaic sets one fixed container height and the tiles divide
   * it (triptych); false when each tile carries its own height.
   */
  fixedHeight: boolean;
}

/**
 * Decide the grid shape for a message that contains `count` standalone
 * images, mirroring the desktop's ImageMosaic rules exactly:
 *
 * - fewer than 2: not a mosaic at all (the single image keeps its own box).
 * - 2: one row, two equal tiles.
 * - 3: a fixed-height, two-row grid where the FIRST image is a full-height
 *   hero and the other two stack beside it.
 * - 4+: a two-column grid of equal tiles; when the count is odd the LAST tile
 *   spans both columns so the grid has no hole.
 */
export function mosaicLayout(count: number): MosaicLayout | null {
  if (!Number.isInteger(count) || count < 2) {
    return null;
  }
  if (count === 2) {
    return {
      shape: "pair",
      rowSpanIndex: null,
      colSpanIndex: null,
      fixedHeight: false,
    };
  }
  if (count === 3) {
    return {
      shape: "triptych",
      rowSpanIndex: 0,
      colSpanIndex: null,
      fixedHeight: true,
    };
  }
  return {
    shape: "grid",
    rowSpanIndex: null,
    colSpanIndex: count % 2 === 1 ? count - 1 : null,
    fixedHeight: false,
  };
}

/** Human-readable byte size: "820 B", "12.4 KB", "3.1 MB" (desktop parity). */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let size = bytes / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size < 10 ? size.toFixed(1) : Math.round(size)} ${units[index]}`;
}

export interface FileCardTarget {
  href: string;
  filename: string;
  size?: number;
}

/**
 * True when an imeta entry describes something that is NOT inline media.
 *
 * An entry with no MIME is deliberately NOT a file: legacy events omit `m`,
 * and the overwhelming majority of those are images. Guessing "file" there
 * would replace working images with download cards.
 */
export function isNonMediaAttachment(entry: ImetaEntry | undefined): boolean {
  if (!entry?.m) {
    return false;
  }
  return !entry.m.startsWith("image/") && !entry.m.startsWith("video/");
}

/**
 * Classify a message link (or an image node — the CLI writes `![image](url)`
 * for EVERY attachment, including PDFs) as a generic-file download card.
 *
 * Mirrors the desktop's `resolveFileCard`: the imeta MIME is authoritative,
 * and the filename falls back through imeta → link text → URL tail.
 */
export function resolveFileCard(
  entry: ImetaEntry | undefined,
  href: string | undefined,
  childText: string,
): FileCardTarget | null {
  if (!href || !isNonMediaAttachment(entry)) {
    return null;
  }
  const trimmed = childText.trim();
  const tail = href.split("/").pop() ?? "";
  const filename = entry?.filename || trimmed || tail || "file";
  return {
    href,
    filename,
    ...(entry?.size === undefined ? {} : { size: entry.size }),
  };
}

export interface GalleryItem {
  /** Object URL for the decoded bytes (what the lightbox renders). */
  src: string;
  alt: string;
}

/**
 * The minimal shape of a lightbox trigger element. Declared structurally so
 * the gallery can be built from plain objects in tests and from real
 * `HTMLElement`s at runtime.
 */
export interface GalleryTriggerLike {
  dataset: {
    lightboxSrc?: string;
    lightboxAlt?: string;
  };
}

/**
 * Build the lightbox gallery for a message from its trigger elements, in DOM
 * order, and locate the clicked one within it.
 *
 * Triggers whose bytes have not resolved yet carry no `lightboxSrc` and are
 * skipped — which is why the index must be recomputed against the FILTERED
 * list rather than reusing the trigger's position in the DOM. A clicked
 * trigger that is itself unresolved cannot happen (the button only exists
 * once the object URL does), but if the scope lookup fails entirely the
 * caller's own trigger is still returned as a one-item gallery.
 */
export function galleryFromTriggers(
  triggers: readonly GalleryTriggerLike[],
  current: GalleryTriggerLike,
): { items: GalleryItem[]; index: number } {
  const items: GalleryItem[] = [];
  let index = -1;
  for (const trigger of triggers) {
    const src = trigger.dataset.lightboxSrc;
    if (!src) {
      continue;
    }
    if (trigger === current) {
      index = items.length;
    }
    items.push({ src, alt: trigger.dataset.lightboxAlt ?? "" });
  }
  if (index === -1) {
    const src = current.dataset.lightboxSrc;
    if (!src) {
      return { items, index: 0 };
    }
    return {
      items: [{ src, alt: current.dataset.lightboxAlt ?? "" }],
      index: 0,
    };
  }
  return { items, index };
}
