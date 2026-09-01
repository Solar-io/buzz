/**
 * Web panel registry — mirrors the desktop's webPanels.config.ts pattern:
 * the Files panel embeds whatever file-manager web app the operator points
 * it at (compile-time env; empty = unconfigured). Buzz ships no file server —
 * see web/docs/COMPATIBILITY.md ("Files panel") for known-good apps.
 */
export const FILES_PANEL_URL: string =
  // Optional chaining: under the node test runner `import.meta.env` is
  // undefined; vite always defines it.
  import.meta.env?.VITE_FILES_PANEL_URL ?? "";
