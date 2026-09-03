/**
 * What the composer's file picker offers, derived from what the relay's
 * Blossom endpoint ACTUALLY accepts — read out of the Rust, not guessed.
 *
 * `PUT /upload` (crates/buzz-relay/src/api/media.rs, `upload_blob`) sniffs the
 * first 4 KiB and routes three ways:
 *
 * 1. `image/jpeg|png|gif|webp` → `process_upload` (thumbnailing image
 *    pipeline). This is the whole of `ALLOWED_MIME_TYPES` in
 *    crates/buzz-media/src/validation.rs.
 * 2. A structurally valid ISO-BMFF `ftyp` box → `process_video_upload`. In
 *    practice that is MP4; other video containers are NOT accepted (see
 *    below).
 * 3. Everything else → `process_file_upload`, the generic attachment path.
 *    That path is a DENY-list, not an allow-list: `validate_file_content`
 *    rejects anything sniffed as `image/*`, `video/*` or `audio/*` (those must
 *    use their own pipelines, and audio has no sanitizer yet), rejects
 *    `BLOCKED_FILE_MIME_TYPES` (SVG, XHTML, JavaScript, and native
 *    executables/installers), and accepts everything else — including files
 *    with no magic signature at all, which store as
 *    `application/octet-stream`. Documents, spreadsheets, slide decks,
 *    archives, and plain text/CSV/JSON/source all pass.
 *
 * The legacy `/media/upload` alias still rejects non-images; the client tries
 * `/upload` first, so the wider set is the one that matters.
 *
 * Two consequences worth stating plainly, because the old five-type list hid
 * them: **audio is rejected by the relay** (deliberately, pending a container
 * sanitizer), and **SVG is rejected** as a stored-XSS carrier. Neither is
 * offered here — offering them would produce a picker entry that always fails.
 */

/** Sniffed image types the relay's image pipeline accepts. */
export const IMAGE_MIMES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;

/** The only video container the relay's streaming pipeline accepts. */
export const VIDEO_MIMES = ["video/mp4"] as const;

/**
 * Generic-attachment types worth naming in the picker's `accept`.
 *
 * The relay's generic path is a deny-list, so this is not exhaustive and does
 * not need to be — `accept` is a browser-side filter hint, and the trailing
 * wildcard entries keep anything else selectable. What it must not do is
 * advertise a type the relay will refuse.
 */
export const FILE_MIMES = [
  "application/pdf",
  "application/zip",
  "application/gzip",
  "application/x-tar",
  "application/x-7z-compressed",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
  "application/json",
  "text/plain",
  "text/csv",
  "text/markdown",
] as const;

/**
 * Extensions for the text-ish files browsers give no MIME type for. Without
 * these the picker greys out a `.log` or a `.ts` even though the relay stores
 * it happily as `application/octet-stream`.
 */
export const FILE_EXTENSIONS = [
  ".txt",
  ".md",
  ".log",
  ".csv",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".diff",
  ".patch",
] as const;

/** MIME types the relay refuses outright — never offered, never uploaded. */
export const REJECTED_MIME_PREFIXES = ["audio/"] as const;

/** Exact MIME types the relay's deny-list blocks. */
export const BLOCKED_MIMES = [
  "image/svg+xml",
  "application/xhtml+xml",
  "application/javascript",
  "text/javascript",
  "application/x-msdownload",
  "application/x-executable",
  "application/vnd.microsoft.portable-executable",
  "application/x-mach-binary",
  "application/x-sharedlib",
  "application/x-elf",
  "application/x-msi",
  "application/vnd.android.package-archive",
  "application/x-apple-diskimage",
] as const;

/** The `accept` attribute for the composer's `<input type="file">`. */
export const ATTACHMENT_ACCEPT = [
  ...IMAGE_MIMES,
  ...VIDEO_MIMES,
  ...FILE_MIMES,
  ...FILE_EXTENSIONS,
].join(",");

/**
 * Whether the composer should even attempt an upload for this file.
 *
 * Cheap client-side pre-flight against the relay's rules, so a user picking an
 * MP3 or an SVG gets a clear message instead of a 4xx from the relay after the
 * bytes have been read and hashed. `null` means "send it"; a string is the
 * reason to show.
 */
export function attachmentRejectionReason(file: {
  name: string;
  type: string;
}): string | null {
  const mime = file.type.toLowerCase();
  if (!mime) {
    // No browser MIME (a .log, a .patch) — the relay stores it as an opaque
    // attachment. Nothing to reject on.
    return null;
  }
  if (REJECTED_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix))) {
    return "Audio uploads are not accepted yet.";
  }
  if ((BLOCKED_MIMES as readonly string[]).includes(mime)) {
    return "That file type is blocked for security reasons.";
  }
  if (
    mime.startsWith("video/") &&
    !(VIDEO_MIMES as readonly string[]).includes(mime)
  ) {
    return "Only MP4 video is accepted.";
  }
  if (
    mime.startsWith("image/") &&
    !(IMAGE_MIMES as readonly string[]).includes(mime)
  ) {
    return "Images must be JPEG, PNG, GIF or WebP.";
  }
  return null;
}
