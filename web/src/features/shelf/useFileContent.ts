import { useEffect, useState } from "react";

import { fetchSignedBytes, fetchSignedMedia } from "@/shared/api/blossom";
import { type PreviewMode, readsText } from "./lib/fileKind.ts";

/**
 * The bytes a previewer needs, through the relay's signed GET (relay media is
 * auth-gated: no `<iframe src>` or `<img src>` can sign a request — the same
 * seam FileCard's download and the inline image already use).
 *
 * - text modes (markdown, HTML, code, CSV, text) decode the bytes as UTF-8;
 * - image, video and audio use `fetchSignedMedia`'s cached object URL;
 * - a PDF is re-wrapped as `application/pdf`, so the browser's own viewer
 *   renders it even when the relay stored it as octet-stream.
 */

/** Bigger than this and a text preview is a download instead. */
export const TEXT_PREVIEW_MAX_BYTES = 5 * 1024 * 1024;

export type FileContent =
  | { phase: "loading" }
  | { phase: "text"; text: string }
  | { phase: "url"; url: string }
  | { phase: "too-large" }
  | { phase: "error"; message: string };

const TEXT_CACHE_MAX = 12;
const textCache = new Map<string, Promise<string>>();

function loadText(url: string): Promise<string> {
  const cached = textCache.get(url);
  if (cached) {
    return cached;
  }
  const promise = fetchSignedBytes(url).then((bytes) =>
    new TextDecoder("utf-8").decode(bytes),
  );
  promise.catch(() => textCache.delete(url));
  textCache.set(url, promise);
  while (textCache.size > TEXT_CACHE_MAX) {
    const oldest = textCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    textCache.delete(oldest);
  }
  return promise;
}

export function useFileContent(
  url: string,
  mode: PreviewMode,
  size: number | null,
  /** Bumped by "Reload preview" to fetch again. */
  reload = 0,
): FileContent {
  const [content, setContent] = useState<FileContent>({ phase: "loading" });
  useEffect(() => {
    let cancelled = false;
    let revoke: string | null = null;
    setContent({ phase: "loading" });
    const fail = () => {
      if (!cancelled) {
        setContent({
          phase: "error",
          message: "Could not load this file from the relay.",
        });
      }
    };
    if (mode === "none") {
      setContent({ phase: "error", message: "No preview for this file type." });
      return;
    }
    if (readsText(mode)) {
      if (size !== null && size > TEXT_PREVIEW_MAX_BYTES) {
        setContent({ phase: "too-large" });
        return;
      }
      if (reload > 0) {
        textCache.delete(url);
      }
      loadText(url).then((text) => {
        if (!cancelled) {
          setContent({ phase: "text", text });
        }
      }, fail);
    } else if (mode === "pdf") {
      fetchSignedBytes(url).then((bytes) => {
        if (cancelled) {
          return;
        }
        revoke = URL.createObjectURL(
          new Blob([bytes as BlobPart], { type: "application/pdf" }),
        );
        setContent({ phase: "url", url: revoke });
      }, fail);
    } else {
      fetchSignedMedia(url).then((objectUrl) => {
        if (!cancelled) {
          setContent({ phase: "url", url: objectUrl });
        }
      }, fail);
    }
    return () => {
      cancelled = true;
      if (revoke) {
        URL.revokeObjectURL(revoke);
      }
    };
  }, [url, mode, size, reload]);
  return content;
}
