/**
 * NIP-92 imeta tag reading for incoming timelines — the web mirror of the
 * desktop's `desktop/src/shared/ui/markdown/parseImeta.ts` (entry shape from
 * `desktop/src/shared/ui/markdown/types.ts`). Pure and import-free of React so
 * the node runner can load this file.
 *
 * The web timeline historically dropped imeta tags at parse time; snapshot
 * cards need the url→entry map to classify attachment links (Phase 3 §0.1).
 */

export interface ImetaEntry {
  /** Blob URL — the map key. Always present on a parsed entry. */
  url: string;
  m?: string;
  /** SHA-256 hex of the attachment bytes (the `x` field). */
  x?: string;
  size?: number;
  filename?: string;
  dim?: string;
  duration?: number;
  blurhash?: string;
  thumb?: string;
}

/** Numeric fields with non-numeric values are skipped, not coerced. */
function numericField(value: string): number | undefined {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Parse ONE `["imeta", "url …", "m …", …]` tag into an entry, or null when the
 * tag is not an imeta tag or carries no `url` field. Fields split at the first
 * space (the desktop's rule), unknown fields are ignored, and the FIRST `url`
 * field in a tag wins — a duplicated `url` inside one tag cannot redirect the
 * entry after later fields were parsed.
 */
export function parseImetaEntry(tag: string[]): ImetaEntry | null {
  if (tag[0] !== "imeta") {
    return null;
  }
  let url: string | undefined;
  let m: string | undefined;
  let x: string | undefined;
  let size: number | undefined;
  let filename: string | undefined;
  let dim: string | undefined;
  let duration: number | undefined;
  let blurhash: string | undefined;
  let thumb: string | undefined;
  for (const field of tag.slice(1)) {
    const spaceIndex = field.indexOf(" ");
    if (spaceIndex === -1) {
      continue;
    }
    const key = field.slice(0, spaceIndex);
    const value = field.slice(spaceIndex + 1);
    switch (key) {
      case "url":
        if (url === undefined) {
          url = value;
        }
        break;
      case "m":
        m = value;
        break;
      case "x":
        x = value;
        break;
      case "size":
        size = numericField(value);
        break;
      case "filename":
        filename = value;
        break;
      case "dim":
        dim = value;
        break;
      case "duration":
        duration = numericField(value);
        break;
      case "blurhash":
        blurhash = value;
        break;
      case "thumb":
        thumb = value;
        break;
      // NIP-92 also defines alt/fallback/image/service — the desktop drops
      // them for our purposes; so do we.
    }
  }
  if (url === undefined) {
    return null;
  }
  const entry: ImetaEntry = { url };
  if (m !== undefined) {
    entry.m = m;
  }
  if (x !== undefined) {
    entry.x = x;
  }
  if (size !== undefined) {
    entry.size = size;
  }
  if (filename !== undefined) {
    entry.filename = filename;
  }
  if (dim !== undefined) {
    entry.dim = dim;
  }
  if (duration !== undefined) {
    entry.duration = duration;
  }
  if (blurhash !== undefined) {
    entry.blurhash = blurhash;
  }
  if (thumb !== undefined) {
    entry.thumb = thumb;
  }
  return entry;
}

/**
 * Project an event's tag list into a url→entry map. Non-imeta tags are
 * ignored; an imeta tag without a url is skipped. When several tags name the
 * same url the LAST one wins, mirroring the desktop's parseImetaTags
 * (`map.set` per tag).
 */
export function imetaByUrl(tags: string[][]): Map<string, ImetaEntry> {
  const map = new Map<string, ImetaEntry>();
  for (const tag of tags) {
    const entry = parseImetaEntry(tag);
    if (entry) {
      map.set(entry.url, entry);
    }
  }
  return map;
}
