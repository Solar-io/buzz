import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, X, ZoomIn, ZoomOut } from "lucide-react";
import { cn } from "@/shared/lib/cn";

export interface LightboxItem {
  src: string;
  alt: string;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;
const WHEEL_ZOOM_SPEED = 0.0025;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not(:disabled)",
  "input:not(:disabled)",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter((element) => element.getClientRects().length > 0);
}

/**
 * Fullscreen image viewer for a message's attachments.
 *
 * It is a gallery, not a single image: `items` is every resolved image in the
 * message in DOM order, and the arrow keys (and the on-screen chevrons) move
 * between them. Zoom runs from 1x to 4x with the keyboard (`+` / `-` / `0`),
 * the toolbar buttons, or the wheel; above 1x the image can be dragged to pan.
 *
 * The overlay is a real modal: body scroll is locked, Tab is trapped inside
 * the dialog, focus lands on the close button on open, and focus returns to
 * whatever opened it on close.
 */
export function Lightbox({
  items,
  index,
  onIndexChange,
  onClose,
  returnFocusTo,
}: {
  items: readonly LightboxItem[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  /**
   * Element to focus on close. Passed explicitly rather than inferred from
   * `document.activeElement` at mount: a click does not reliably leave focus
   * on the button that was clicked, and inferring it drops focus to `body`.
   */
  returnFocusTo?: HTMLElement | null;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ x: number; y: number } | null>(null);

  const safeIndex = clamp(index, 0, Math.max(0, items.length - 1));
  const item = items[safeIndex];
  const count = items.length;

  const goTo = useCallback(
    (next: number) => {
      const clamped = clamp(next, 0, Math.max(0, count - 1));
      if (clamped !== safeIndex) {
        setZoom(MIN_ZOOM);
        setOffset({ x: 0, y: 0 });
        onIndexChange(clamped);
      }
    },
    [count, onIndexChange, safeIndex],
  );

  const nudgeZoom = useCallback((delta: number) => {
    setZoom((current) => {
      const next = clamp(current + delta, MIN_ZOOM, MAX_ZOOM);
      if (next === MIN_ZOOM) {
        setOffset({ x: 0, y: 0 });
      }
      return next;
    });
  }, []);

  // Escape / arrows / zoom keys, plus the Tab focus trap. One window-level
  // listener so the shortcuts work wherever focus happens to sit inside the
  // overlay.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        goTo(safeIndex - 1);
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        goTo(safeIndex + 1);
        return;
      }
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        nudgeZoom(ZOOM_STEP);
        return;
      }
      if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        nudgeZoom(-ZOOM_STEP);
        return;
      }
      if (event.key === "0") {
        event.preventDefault();
        setZoom(MIN_ZOOM);
        setOffset({ x: 0, y: 0 });
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const dialog = dialogRef.current;
      if (!dialog) {
        return;
      }
      const focusables = focusableWithin(dialog);
      if (focusables.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !dialog.contains(active)) {
        event.preventDefault();
        first.focus();
        return;
      }
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goTo, nudgeZoom, onClose, safeIndex]);

  // Lock body scroll, and hand focus back to the trigger on close.
  useEffect(() => {
    const fallback =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      const target = returnFocusTo ?? fallback;
      if (!target) {
        return;
      }
      // Restore on the next frame, not inline: the overlay's own nodes are
      // still being torn down when this cleanup runs, and removing the
      // focused node afterwards resets focus to <body> — silently undoing an
      // inline focus() call. Measured in Brave, 2026-09-03.
      requestAnimationFrame(() => {
        if (target.isConnected) {
          target.focus();
        }
      });
    };
  }, [returnFocusTo]);

  if (!item) {
    return null;
  }

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes via the window listener above
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={item.alt ? `Image: ${item.alt}` : "Image viewer"}
      className="fixed inset-0 z-50 flex items-center justify-center overflow-hidden bg-black/85 p-4 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
      onWheel={(event) => {
        nudgeZoom(-event.deltaY * WHEEL_ZOOM_SPEED);
      }}
    >
      <img
        data-testid="lightbox-image"
        src={item.src}
        alt={item.alt}
        draggable={false}
        className={cn(
          "max-h-full max-w-full select-none rounded-lg object-contain shadow-2xl",
          zoom > MIN_ZOOM ? "cursor-grab" : "cursor-default",
        )}
        style={{
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
        }}
        onPointerDown={(event) => {
          if (zoom <= MIN_ZOOM) {
            return;
          }
          dragRef.current = {
            x: event.clientX - offset.x,
            y: event.clientY - offset.y,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const origin = dragRef.current;
          if (!origin) {
            return;
          }
          setOffset({
            x: event.clientX - origin.x,
            y: event.clientY - origin.y,
          });
        }}
        onPointerUp={(event) => {
          dragRef.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
      />

      {count > 1 ? (
        <>
          <button
            type="button"
            aria-label="Previous image"
            data-testid="lightbox-prev"
            disabled={safeIndex === 0}
            className="absolute left-4 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20 disabled:opacity-30 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/70"
            onClick={() => goTo(safeIndex - 1)}
          >
            <ChevronLeft className="h-5 w-5" aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="Next image"
            data-testid="lightbox-next"
            disabled={safeIndex === count - 1}
            className="absolute right-4 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20 disabled:opacity-30 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/70"
            onClick={() => goTo(safeIndex + 1)}
          >
            <ChevronRight className="h-5 w-5" aria-hidden="true" />
          </button>
        </>
      ) : null}

      <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full bg-white/10 px-3 py-1.5 text-white backdrop-blur-sm">
        <button
          type="button"
          aria-label="Zoom out"
          data-testid="lightbox-zoom-out"
          disabled={zoom <= MIN_ZOOM}
          className="rounded-full p-1 transition-colors hover:bg-white/20 disabled:opacity-30 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/70"
          onClick={() => nudgeZoom(-ZOOM_STEP)}
        >
          <ZoomOut className="h-4 w-4" aria-hidden="true" />
        </button>
        <span
          data-testid="lightbox-zoom-level"
          className="min-w-12 text-center text-xs tabular-nums"
        >
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          aria-label="Zoom in"
          data-testid="lightbox-zoom-in"
          disabled={zoom >= MAX_ZOOM}
          className="rounded-full p-1 transition-colors hover:bg-white/20 disabled:opacity-30 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/70"
          onClick={() => nudgeZoom(ZOOM_STEP)}
        >
          <ZoomIn className="h-4 w-4" aria-hidden="true" />
        </button>
        {count > 1 ? (
          <span
            data-testid="lightbox-counter"
            className="ml-1 border-l border-white/20 pl-3 text-xs tabular-nums"
          >
            {safeIndex + 1} / {count}
          </span>
        ) : null}
      </div>

      <button
        ref={closeRef}
        type="button"
        aria-label="Close"
        data-testid="lightbox-close"
        className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/70"
        onClick={onClose}
      >
        <X className="h-5 w-5" aria-hidden="true" />
      </button>
    </div>
  );
}
