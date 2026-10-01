import { Download, FileWarning } from "lucide-react";

import { MarkdownContent } from "@/features/channels/ui/MarkdownContent";
import { cn } from "@/shared/lib/cn";
import { Skeleton } from "@/shared/ui/skeleton";
import { parseDelimited } from "../lib/csv.ts";
import { fileExtension, type PreviewMode } from "../lib/fileKind.ts";
import type { FileContent } from "../useFileContent.ts";
import { CodeView } from "./CodeView";
import { HtmlPreview } from "./HtmlPreview";

const NO_MENTIONS: ReadonlySet<string> = new Set();

/** How tall a frame-like preview (web page, PDF) stands in each surface. */
export type PreviewFit = "dock" | "fill";

function frameHeight(fit: PreviewFit): string {
  return fit === "dock" ? "h-[min(68vh,44rem)]" : "h-[calc(100dvh-15rem)]";
}

function Unavailable({
  message,
  onDownload,
}: {
  message: string;
  onDownload: () => void;
}) {
  return (
    <div
      data-testid="file-preview-unavailable"
      className="flex min-h-40 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-line-2 px-4 py-8 text-center"
    >
      <FileWarning aria-hidden className="size-6 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">{message}</p>
      <button
        type="button"
        onClick={onDownload}
        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-2 bg-card px-3 text-xs font-semibold hover:bg-accent"
      >
        <Download aria-hidden className="size-3.5" />
        Download instead
      </button>
    </div>
  );
}

function Table({ text, filename }: { text: string; filename: string }) {
  const separator = fileExtension(filename) === "tsv" ? "\t" : ",";
  const { rows, truncated } = parseDelimited(text, separator);
  const [head, ...body] = rows;
  if (!head) {
    return <p className="text-sm text-muted-foreground">This file is empty.</p>;
  }
  return (
    <div
      data-testid="file-table-view"
      className="overflow-auto rounded-lg border border-border bg-card"
    >
      <table className="w-full border-collapse text-xs">
        <thead className="sticky top-0 bg-sunk">
          <tr>
            {head.map((cell, index) => (
              <th
                // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional
                key={index}
                className="border-b border-border px-2.5 py-1.5 text-left font-semibold whitespace-nowrap text-muted-foreground"
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, rowIndex) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
            <tr key={rowIndex} className="border-b border-border last:border-0">
              {head.map((_, cellIndex) => (
                <td
                  // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional
                  key={cellIndex}
                  className={cn(
                    "px-2.5 py-1.5 align-top",
                    /^-?[\d.,]+%?$/.test(row[cellIndex] ?? "") &&
                      "text-right font-mono tabular-nums",
                  )}
                >
                  {row[cellIndex] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {truncated ? (
        <p className="border-t border-border px-2.5 py-1.5 text-2xs text-muted-foreground">
          First {rows.length} rows — download for the rest.
        </p>
      ) : null}
    </div>
  );
}

/**
 * One file, rendered by kind (phase-6 "Previewers"): markdown through the
 * message renderer, images, code through Shiki, PDFs in the browser's own
 * viewer, HTML in the opaque-origin sandbox, CSV as a table. "Source" shows
 * the bytes with line numbers for the kinds whose preview is a rendering.
 */
export function FilePreviewBody({
  content,
  mode,
  view,
  filename,
  language,
  fit,
  reloadKey,
  onDownload,
}: {
  content: FileContent;
  mode: PreviewMode;
  view: "preview" | "source";
  filename: string;
  language: string;
  fit: PreviewFit;
  reloadKey: number;
  onDownload: () => void;
}) {
  if (content.phase === "loading") {
    return (
      <div data-testid="file-preview-loading" className="flex flex-col gap-2">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-4 w-4/6" />
      </div>
    );
  }
  if (content.phase === "too-large") {
    return (
      <Unavailable
        message="Too large to preview here."
        onDownload={onDownload}
      />
    );
  }
  if (content.phase === "error") {
    return <Unavailable message={content.message} onDownload={onDownload} />;
  }
  if (content.phase === "text") {
    if (view === "source" || mode === "code") {
      return <CodeView text={content.text} language={language} />;
    }
    switch (mode) {
      case "markdown":
        return (
          <div
            data-testid="file-markdown-view"
            className="[&_h1]:font-serif [&_h1]:text-2xl [&_h1]:font-semibold [&_h1]:tracking-tight [&_h2]:text-base [&_h2]:font-semibold"
          >
            <MarkdownContent
              content={content.text}
              mentionNames={NO_MENTIONS}
            />
          </div>
        );
      case "html":
        return (
          <HtmlPreview
            key={reloadKey}
            html={content.text}
            title={filename}
            className={cn(
              "block w-full rounded-[10px] border border-border bg-white",
              frameHeight(fit),
            )}
          />
        );
      case "table":
        return <Table text={content.text} filename={filename} />;
      default:
        return (
          <pre
            data-testid="file-text-view"
            className="rounded-lg border border-border bg-card p-3 font-mono text-xs leading-5 whitespace-pre-wrap break-words"
          >
            {content.text}
          </pre>
        );
    }
  }
  switch (mode) {
    case "image":
      return (
        <div className="grid place-items-center rounded-lg bg-sunk p-2">
          <img
            data-testid="file-image-view"
            src={content.url}
            alt={filename}
            className="max-h-[70vh] max-w-full rounded object-contain"
          />
        </div>
      );
    case "pdf":
      return (
        <iframe
          data-testid="file-pdf-view"
          src={content.url}
          title={`PDF: ${filename}`}
          className={cn(
            "block w-full rounded-[10px] border border-border bg-card",
            frameHeight(fit),
          )}
        />
      );
    case "video":
      return (
        // biome-ignore lint/a11y/useMediaCaption: shared files carry no caption tracks
        <video src={content.url} controls className="w-full rounded-lg" />
      );
    case "audio":
      return (
        // biome-ignore lint/a11y/useMediaCaption: shared files carry no caption tracks
        <audio src={content.url} controls className="w-full" />
      );
    default:
      return (
        <Unavailable
          message="No preview for this file type."
          onDownload={onDownload}
        />
      );
  }
}
