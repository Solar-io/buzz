/**
 * Clipboard-image extraction for the composer's paste handler.
 *
 * Screenshot paste (Sam, 2026-09-02: "we also need the ability to copy and
 * paste screenshots"): macOS/Windows "copy screenshot" puts an image file on
 * the clipboard — `event.clipboardData.files` in most browsers, but some
 * (notably Safari with copied images) expose it only through
 * `clipboardData.items[i].getAsFile()`. Collect from BOTH, deduped by
 * (name, size, type) since the two views often describe the same file.
 * Only image/* files are taken; pasted text and other file types pass
 * through untouched so the browser's default paste keeps working.
 */

/** Collect image files from a paste event's clipboard data. Pure. */
export function imageFilesFromClipboard(data: DataTransfer | null): File[] {
  if (!data) {
    return [];
  }
  const seen = new Set<string>();
  const out: File[] = [];
  const take = (file: File | null) => {
    if (!file?.type.startsWith("image/")) {
      return;
    }
    const key = `${file.name}:${file.size}:${file.type}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    out.push(file);
  };
  for (const file of Array.from(data.files ?? [])) {
    take(file);
  }
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === "file") {
      take(item.getAsFile());
    }
  }
  return out;
}
