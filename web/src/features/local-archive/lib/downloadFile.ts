/**
 * Hand a generated file to the browser's download machinery.
 *
 * A browser cannot write to a chosen folder without a user gesture, which is
 * the whole reason this feature is an *export* rather than the desktop app's
 * background mirror. An object URL plus a synthetic anchor click is the one
 * mechanism every target browser supports.
 */

/** Revoke well after the click so slow browsers still resolve the URL. */
const REVOKE_DELAY_MS = 60_000;

export interface DownloadDeps {
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
  document: Document;
  setTimeout: (handler: () => void, timeout: number) => unknown;
}

function browserDeps(): DownloadDeps {
  return {
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    document,
    setTimeout: (handler, timeout) => window.setTimeout(handler, timeout),
  };
}

/**
 * Trigger a download of `blob` named `fileName`.
 *
 * Returns the object URL it created, so a caller (or a browser probe) can
 * read back exactly what was handed to the user.
 */
export function downloadBlob(
  fileName: string,
  blob: Blob,
  deps: DownloadDeps = browserDeps(),
): string {
  const url = deps.createObjectURL(blob);
  const anchor = deps.document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  deps.document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  deps.setTimeout(() => deps.revokeObjectURL(url), REVOKE_DELAY_MS);
  return url;
}

/** Build the Blob for a serialised archive. */
export function archiveBlob(text: string, mimeType: string): Blob {
  return new Blob([text], { type: mimeType });
}
