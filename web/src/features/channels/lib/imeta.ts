import type { BlobDescriptor } from "@/shared/api/blossom";

/**
 * imeta tag + content-markdown construction, mirroring the CLI's
 * build_imeta_tag and media_content appends byte-for-byte in shape.
 */
export function buildImetaTag(descriptor: BlobDescriptor): string[] {
  const tag = [
    "imeta",
    `url ${descriptor.url}`,
    `m ${descriptor.mime_type}`,
    `x ${descriptor.sha256}`,
    `size ${descriptor.size}`,
  ];
  if (descriptor.dim) {
    tag.push(`dim ${descriptor.dim}`);
  }
  if (descriptor.blurhash) {
    tag.push(`blurhash ${descriptor.blurhash}`);
  }
  if (descriptor.thumb) {
    tag.push(`thumb ${descriptor.thumb}`);
  }
  if (typeof descriptor.duration === "number") {
    tag.push(`duration ${descriptor.duration}`);
  }
  return tag;
}

/** Markdown appended to content for an uploaded descriptor. */
export function mediaMarkdown(descriptor: BlobDescriptor): string {
  const kind = descriptor.mime_type.startsWith("video/") ? "video" : "image";
  return `\n![${kind}](${descriptor.url})`;
}

/** Extract blob URLs referenced by imeta tags in an event's tag list. */
export function imetaUrls(tags: string[][]): string[] {
  const urls: string[] = [];
  for (const tag of tags) {
    if (tag[0] !== "imeta") {
      continue;
    }
    for (const field of tag.slice(1)) {
      if (field.startsWith("url ")) {
        urls.push(field.slice(4));
      }
    }
  }
  return urls;
}
