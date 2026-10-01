/**
 * What a shared file IS, for the Shelf's type chips, a tile's icon and the
 * previewer that opens it (web redesign Phase 6).
 *
 * The extension decides first, the MIME second. That order is deliberate:
 * the relay stores text with no magic bytes — markdown, HTML, CSV — as
 * `application/octet-stream` (phase-6.md D6.4/D6.5), so the stored MIME of a
 * `report.md` says nothing about it. `m` stays the truthful stored type and
 * the filename says what to render it as.
 *
 * Pure and import-free so `node --test` loads it directly.
 */

export type FileKind =
  | "markdown"
  | "html"
  | "image"
  | "pdf"
  | "code"
  | "data"
  | "text"
  | "video"
  | "audio"
  | "other";

/** The Shelf's type chips. */
export type ShelfCategory =
  | "docs"
  | "web"
  | "code"
  | "images"
  | "data"
  | "other";

export const SHELF_CATEGORIES: readonly ShelfCategory[] = [
  "docs",
  "web",
  "code",
  "images",
  "data",
  "other",
];

export const CATEGORY_LABEL: Record<ShelfCategory, string> = {
  docs: "Docs",
  web: "Web pages",
  code: "Code",
  images: "Images",
  data: "Data",
  other: "Other",
};

/** How the pane renders a file. */
export type PreviewMode =
  | "markdown"
  | "html"
  | "image"
  | "pdf"
  | "code"
  | "table"
  | "text"
  | "video"
  | "audio"
  | "none";

/** Extension → Shiki language id, for code and data files. */
const LANGUAGE: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  py: "python",
  rs: "rust",
  go: "go",
  rb: "ruby",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  swift: "swift",
  kt: "kotlin",
  java: "java",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  css: "css",
  scss: "scss",
  dart: "dart",
  lua: "lua",
  php: "php",
  sql: "sql",
  json: "json",
  jsonl: "json",
  ndjson: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  xml: "xml",
  html: "html",
  htm: "html",
  md: "markdown",
  markdown: "markdown",
  diff: "diff",
  patch: "diff",
};

const CODE = new Set([
  "ts",
  "mts",
  "cts",
  "tsx",
  "js",
  "mjs",
  "cjs",
  "jsx",
  "py",
  "rs",
  "go",
  "rb",
  "sh",
  "bash",
  "zsh",
  "swift",
  "kt",
  "java",
  "c",
  "h",
  "cc",
  "cpp",
  "hpp",
  "cs",
  "css",
  "scss",
  "dart",
  "lua",
  "php",
  "diff",
  "patch",
]);
const DATA = new Set([
  "csv",
  "tsv",
  "json",
  "jsonl",
  "ndjson",
  "xml",
  "yaml",
  "yml",
  "toml",
  "sql",
  "log",
]);
const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp"]);
const VIDEO = new Set(["mp4", "webm", "mov", "m4v"]);
const AUDIO = new Set(["mp3", "wav", "flac", "ogg", "m4a", "aac"]);

/** Lowercased extension without the dot, or "" (none, or implausibly long). */
export function fileExtension(filename: string): string {
  const match = /\.([A-Za-z0-9]{1,10})$/.exec(filename);
  return match ? match[1].toLowerCase() : "";
}

export function fileKind(filename: string, mime?: string | null): FileKind {
  const ext = fileExtension(filename);
  if (ext === "md" || ext === "markdown" || ext === "mdx") {
    return "markdown";
  }
  if (ext === "html" || ext === "htm") {
    return "html";
  }
  if (IMAGE.has(ext)) {
    return "image";
  }
  if (ext === "pdf") {
    return "pdf";
  }
  if (CODE.has(ext)) {
    return "code";
  }
  if (DATA.has(ext)) {
    return "data";
  }
  if (ext === "txt" || ext === "text" || ext === "rst") {
    return "text";
  }
  if (VIDEO.has(ext)) {
    return "video";
  }
  if (AUDIO.has(ext)) {
    return "audio";
  }
  const type = (mime ?? "").toLowerCase().split(";")[0].trim();
  if (type.startsWith("image/")) {
    return "image";
  }
  if (type === "application/pdf") {
    return "pdf";
  }
  if (type === "text/markdown") {
    return "markdown";
  }
  if (type === "text/html") {
    return "html";
  }
  if (type.startsWith("video/")) {
    return "video";
  }
  if (type.startsWith("audio/")) {
    return "audio";
  }
  if (type === "application/json" || type === "text/csv") {
    return "data";
  }
  if (type.startsWith("text/")) {
    return "text";
  }
  return "other";
}

export function shelfCategory(kind: FileKind): ShelfCategory {
  switch (kind) {
    case "markdown":
    case "pdf":
    case "text":
      return "docs";
    case "html":
      return "web";
    case "code":
      return "code";
    case "image":
      return "images";
    case "data":
      return "data";
    default:
      return "other";
  }
}

/** The word a row or a tile says the file is ("Document · 9 KB"). */
export function kindLabel(kind: FileKind): string {
  switch (kind) {
    case "markdown":
    case "text":
      return "Document";
    case "html":
      return "Web page";
    case "image":
      return "Image";
    case "pdf":
      return "PDF";
    case "code":
      return "Code";
    case "data":
      return "Data";
    case "video":
      return "Video";
    case "audio":
      return "Audio";
    default:
      return "File";
  }
}

export function previewMode(filename: string, kind: FileKind): PreviewMode {
  switch (kind) {
    case "markdown":
      return "markdown";
    case "html":
      return "html";
    case "image":
      return "image";
    case "pdf":
      return "pdf";
    case "code":
      return "code";
    case "data": {
      const ext = fileExtension(filename);
      if (ext === "csv" || ext === "tsv") {
        return "table";
      }
      return ext === "log" ? "text" : "code";
    }
    case "text":
      return "text";
    case "video":
      return "video";
    case "audio":
      return "audio";
    default:
      return "none";
  }
}

/** A rendered preview that differs from the bytes gets a Source view. */
export function hasSourceView(mode: PreviewMode): boolean {
  return mode === "markdown" || mode === "html" || mode === "table";
}

/** Modes that read the file as text (and so are bounded by size). */
export function readsText(mode: PreviewMode): boolean {
  return (
    mode === "markdown" ||
    mode === "html" ||
    mode === "code" ||
    mode === "table" ||
    mode === "text"
  );
}

/** Shiki language for a file's source, or "" for plain text. */
export function sourceLanguage(filename: string): string {
  return LANGUAGE[fileExtension(filename)] ?? "";
}

/** Words at a reading pace — "2 min read" for a document. Never 0. */
export function readMinutes(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 230));
}
