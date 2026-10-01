import { useEffect } from "react";

import type { OpenFile } from "../lib/fileTabs.ts";
import { FilePreview } from "./FilePreview";

/**
 * Below lg a file opens over everything, full screen (phase-6 "Phone: a
 * full-screen preview sheet"): there is no dock to put a tab in. Escape and
 * the sheet's ✕ close it, and closing it closes the file.
 */
export function FilePreviewSheet({
  file,
  onClose,
}: {
  file: OpenFile;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    globalThis.addEventListener("keydown", onKey);
    return () => globalThis.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={file.filename}
      data-testid="file-preview-sheet"
      className="fixed inset-0 z-50 flex flex-col bg-background pt-[env(safe-area-inset-top)] motion-safe:animate-in motion-safe:slide-in-from-bottom-4 motion-safe:fade-in-0"
    >
      <FilePreview file={file} variant="sheet" onClose={onClose} />
    </div>
  );
}
