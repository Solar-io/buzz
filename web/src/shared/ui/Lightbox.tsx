import { useEffect } from "react";

/**
 * Fullscreen image viewer: click the backdrop or press Esc to close. Locks
 * body scroll while open so the timeline doesn't scroll underneath.
 */
export function Lightbox({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Esc handling is registered on window above
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt ? `Image: ${alt}` : "Image viewer"}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      {/* Stop propagation so clicking the image itself does not close. */}
      <button
        type="button"
        aria-label="Image"
        className="max-h-full max-w-full cursor-default border-0 bg-transparent p-0"
        onClick={(event) => event.stopPropagation()}
      >
        <img
          src={src}
          alt={alt}
          className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
        />
      </button>
      <button
        type="button"
        aria-label="Close"
        className="absolute right-4 top-4 rounded-full bg-white/10 px-3 py-1.5 text-lg text-white hover:bg-white/20"
        onClick={onClose}
      >
        ✕
      </button>
    </div>
  );
}
