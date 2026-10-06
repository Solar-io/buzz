/**
 * "Open in Files" — the stash `?path=` deep link (redesign Phase 4; stash
 * `app/public/js/shell/deep-link.js`).
 *
 * stash opens on the folder a URL names: `?path=/abs/folder` (the server maps
 * it to one of its roots and refuses anything outside them), and a FILE
 * opens itself — the editor (or viewer) over the whole page, the file
 * manager hidden until it is closed. It reads the parameter once at boot and
 * strips it from its address bar, so opening a path means loading the frame
 * with this URL — the frame host remounts the Files frame for it.
 *
 * The client check here only refuses obviously malformed input early; stash's
 * server is authoritative for containment. A `~/…` path is refused: stash
 * speaks absolute paths, and guessing the home directory here would be a lie.
 *
 * Pure and import-free so `node --test` can load it directly.
 */

/** stash's own `MAX_PATH`. */
export const MAX_FILES_PATH = 4096;

/** An absolute path stash will even consider, or false. Pure. */
export function isFilesPath(path: string): boolean {
  return (
    typeof path === "string" &&
    path.startsWith("/") &&
    path.length <= MAX_FILES_PATH &&
    !path.includes("\0")
  );
}

/**
 * The Files URL that opens on `absPath`, or null for a path stash would
 * refuse or a panel URL that does not parse. Keeps the panel's own query
 * (a pinned `?theme=` survives), drops any `root=` (it would turn the path
 * into a root-relative one) and any fragment. Pure.
 */
export function filesPathUrl(panelUrl: string, absPath: string): string | null {
  if (!isFilesPath(absPath)) {
    return null;
  }
  try {
    const url = new URL(panelUrl);
    url.searchParams.delete("root");
    url.searchParams.set("path", absPath);
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}
