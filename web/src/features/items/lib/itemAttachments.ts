import type { BlobDescriptor } from "@/shared/api/blossom";
import { attachmentMarkdown } from "../../channels/lib/attachmentMarkdown.ts";
import { ITEM_BODY_MAX_BYTES } from "./itemEvent.ts";

/** Item attachments retain their filename, with only images embedded inline. */
export function itemAttachmentMarkdown(
  descriptor: BlobDescriptor,
  name: string,
): string {
  const url = descriptor.url.replace(/[()<>\\\s]/g, (character) =>
    encodeURIComponent(character),
  );
  const label = name.replace(/[\\!*_`<>]/g, "\\$&");
  const link = attachmentMarkdown(
    { ...descriptor, url, mime_type: "application/octet-stream" },
    label,
  ).slice(1);
  return `${descriptor.mime_type.startsWith("image/") ? "!" : ""}${link}`;
}

/** The relay bounds the body by UTF-8 bytes, not JavaScript string length. */
export function itemBodyBytes(body: string): number {
  return new TextEncoder().encode(body).length;
}

/** Replace a textarea selection without losing surrounding prose or splitting lines. */
export function insertItemAttachment(
  body: string,
  start: number,
  end: number,
  markdown: string,
): { body: string; cursor: number } {
  const from = Math.max(0, Math.min(body.length, start));
  const to = Math.max(from, Math.min(body.length, end));
  const before = body.slice(0, from);
  const after = body.slice(to);
  const insertion = `${before && !before.endsWith("\n") ? "\n" : ""}${markdown}\n`;
  const next = before + insertion + after;
  if (itemBodyBytes(next) > ITEM_BODY_MAX_BYTES) {
    throw new Error(
      `Description exceeds ${ITEM_BODY_MAX_BYTES} bytes. Shorten it before attaching this file.`,
    );
  }
  return { body: next, cursor: before.length + insertion.length };
}
