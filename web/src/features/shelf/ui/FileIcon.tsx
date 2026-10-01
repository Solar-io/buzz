import {
  Braces,
  CodeXml,
  File,
  FileText,
  Film,
  Image,
  Music,
  Table,
} from "lucide-react";

import { cn } from "@/shared/lib/cn";
import type { FileKind } from "../lib/fileKind.ts";

/**
 * The typed square that leads a Shelf row and a file tile (Shelf artboard):
 * documents on honey, web pages on blue with `<>`, everything else on the
 * quiet chip. Colour is a second channel only — the filename's extension and
 * the kind label always say the same thing in words.
 */
const TONE: Record<FileKind, string> = {
  markdown: "bg-honey-soft text-honey-ink",
  text: "bg-honey-soft text-honey-ink",
  pdf: "bg-honey-soft text-honey-ink",
  html: "bg-info-soft text-info-ink",
  code: "bg-info-soft text-info-ink",
  image: "bg-chip text-ink-2",
  data: "bg-chip text-ink-2",
  video: "bg-chip text-ink-2",
  audio: "bg-chip text-ink-2",
  other: "bg-chip text-ink-2",
};

function Glyph({ kind, className }: { kind: FileKind; className: string }) {
  switch (kind) {
    case "markdown":
    case "text":
    case "pdf":
      return <FileText aria-hidden className={className} />;
    case "html":
      return <CodeXml aria-hidden className={className} />;
    case "code":
      return <Braces aria-hidden className={className} />;
    case "image":
      return <Image aria-hidden className={className} />;
    case "data":
      return <Table aria-hidden className={className} />;
    case "video":
      return <Film aria-hidden className={className} />;
    case "audio":
      return <Music aria-hidden className={className} />;
    default:
      return <File aria-hidden className={className} />;
  }
}

export function FileIcon({
  kind,
  size = "md",
  className,
}: {
  kind: FileKind;
  /** sm 24 · md 28 (Shelf row) · lg 30 (message tile). */
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  return (
    <span
      aria-hidden
      data-kind={kind}
      className={cn(
        "grid shrink-0 place-items-center",
        size === "sm"
          ? "size-6 rounded-md"
          : size === "md"
            ? "size-7 rounded-[7px]"
            : "size-7.5 rounded-[7px]",
        TONE[kind],
        className,
      )}
    >
      <Glyph kind={kind} className={size === "sm" ? "size-3" : "size-3.5"} />
    </span>
  );
}
