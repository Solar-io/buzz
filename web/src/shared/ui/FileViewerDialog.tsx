import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Download, FileText } from "lucide-react";
import { fetchSignedMedia } from "@/shared/api/blossom";
import {
  fileViewerKind,
  isRelayEditionHref,
  isRelayMediaHref,
  type FileViewerKind,
} from "@/shared/lib/linkOpen";
import { Spinner } from "@/shared/ui/spinner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";

/**
 * In-app file viewer — the replacement for the old popup-viewer window.
 *
 * A link click must never manufacture an OS window: in the installed PWA
 * every window.open surface carries browser chrome (the URL-row toolbar),
 * and stale-scope installs keep that behavior forever. This overlay renders
 * file-typical links inside the SPA instead, so no window is created and
 * the install scope is irrelevant.
 *
 * Rendering dispatch comes from `fileViewerKind` (linkOpen). Relay media
 * URLs are auth-gated, so they are resolved through `fetchSignedMedia`'
 * cached object URLs first — the same seam the inline `<img>` path and the
 * FileCard download already use. Repeat opens of the same media are instant
 * (blossom's objectUrlCache).
 *
 * HTML renders in an iframe sandboxed with `allow-same-origin` ONLY: no
 * `allow-scripts` (viewer-surfaces pages must not execute code in-app) and
 * no `allow-top-navigation` (a page must never be able to navigate the SPA
 * away). The tracker page's own tracker.json fetch is CORS-permissive (`*`)
 * upstream, which is why serving its documents same-origin works at all.
 */

const FileViewerContext = createContext<{
  openViewer: (url: string) => void;
} | null>(null);

/**
 * The overlay opener, or null outside a provider (honest-absent — callers
 * degrade to a plain `_blank` tab, never a dead button).
 */
export function useFileViewer(): ((url: string) => void) | null {
  return useContext(FileViewerContext)?.openViewer ?? null;
}

export function FileViewerProvider({
  relayBase,
  children,
}: {
  /** HTTP base of the relay, for relay-media detection (same contract as `isRelayMediaHref`). */
  relayBase: string;
  children: ReactNode;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const openViewer = useCallback((next: string) => setUrl(next), []);
  const contextValue = useMemo(() => ({ openViewer }), [openViewer]);

  return (
    <FileViewerContext.Provider value={contextValue}>
      {children}
      {url !== null ? (
        <FileViewerDialog
          url={url}
          relayBase={relayBase}
          onClose={() => setUrl(null)}
        />
      ) : null}
    </FileViewerContext.Provider>
  );
}

/** Decoded last path segment — the dialog title. */
function viewerTitle(url: string): string {
  let raw = url;
  try {
    raw = new URL(url, window.location.origin).pathname.split("/").pop() ?? url;
  } catch {
    // Non-URL string: fall through with the raw text.
  }
  const segment = raw;
  try {
    return decodeURIComponent(segment) || "file";
  } catch {
    return segment || "file";
  }
}

const KIND_LABELS: Record<FileViewerKind, string> = {
  image: "Image",
  video: "Video",
  audio: "Audio",
  pdf: "PDF document",
  markdown: "Markdown",
  text: "Text",
  html: "Web page",
  fallback: "File",
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type BodyState =
  | { phase: "loading" }
  | { phase: "ready"; src: string; text?: string; size?: number }
  | { phase: "error"; message: string };

/**
 * Resolve the display source for one viewer URL. Relay media is signed-
 * fetched to an object URL first; markdown/text additionally read the bytes
 * (through the object URL when signed, plain fetch otherwise).
 */
function useViewerSource(
  url: string,
  kind: FileViewerKind,
  signed: boolean,
): BodyState {
  const [state, setState] = useState<BodyState>({ phase: "loading" });
  useEffect(() => {
    let cancelled = false;
    setState({ phase: "loading" });
    const needsText = kind === "markdown" || kind === "text";
    (async () => {
      try {
        const src = signed ? await fetchSignedMedia(url) : url;
        if (!needsText) {
          if (!cancelled) setState({ phase: "ready", src });
          return;
        }
        const response = await fetch(src);
        if (!response.ok) {
          throw new Error(`fetch failed (${response.status})`);
        }
        const text = await response.text();
        if (cancelled) return;
        setState({ phase: "ready", src, text, size: text.length });
      } catch {
        if (!cancelled) {
          setState({
            phase: "error",
            message: signed
              ? "Could not load that file from the relay store (auth failed)."
              : "Could not load that file.",
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url, kind, signed]);
  return state;
}

function FileViewerDialog({
  url,
  relayBase,
  onClose,
}: {
  url: string;
  relayBase: string;
  onClose: () => void;
}) {
  const kind = fileViewerKind(url);
  const signed = isRelayMediaHref(url, relayBase);
  const title = viewerTitle(url);
  const state = useViewerSource(url, kind, signed);
  const [downloading, setDownloading] = useState(false);
  const [downloadFailed, setDownloadFailed] = useState(false);

  const sizeLabel =
    state.phase === "ready" && state.size !== undefined
      ? formatSize(state.size)
      : null;

  const download = useCallback(() => {
    setDownloading(true);
    setDownloadFailed(false);
    const resolved = signed ? fetchSignedMedia(url) : Promise.resolve(url);
    resolved
      .then((objectUrl) => {
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = title;
        anchor.rel = "noopener";
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
      })
      .catch(() => setDownloadFailed(true))
      .finally(() => setDownloading(false));
  }, [signed, url, title]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        data-testid="file-viewer-dialog"
        className={
          kind === "html"
            ? // A page-type file is a whole document (the Daily Edition is a
              // ~1020px grid with its own tabs) — give it the window, not a
              // 5xl box, or its layout compresses into unreadable cards.
              "h-[90vh] w-[96vw] max-w-[1400px] grid-rows-[auto_minmax(0,1fr)]"
            : "max-w-5xl grid-rows-[auto_minmax(0,1fr)]"
        }
      >
        <DialogHeader className="flex-row items-start justify-between gap-4 space-y-0 pr-10">
          <div className="min-w-0">
            <DialogTitle className="truncate text-base">{title}</DialogTitle>
            <DialogDescription>
              {KIND_LABELS[kind]}
              {sizeLabel ? ` · ${sizeLabel}` : ""}
            </DialogDescription>
          </div>
          <button
            type="button"
            data-testid="file-viewer-download"
            disabled={downloading}
            onClick={download}
            className="flex shrink-0 items-center gap-1.5 rounded-md border border-border/70 px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-70"
          >
            {downloading ? (
              <Spinner className="h-3.5 w-3.5" />
            ) : (
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            Download
          </button>
        </DialogHeader>
        <FileViewerBody
          kind={kind}
          title={title}
          state={state}
          downloadFailed={downloadFailed}
          onDownload={download}
          allowScripts={kind === "html" && isRelayEditionHref(url, relayBase)}
        />
      </DialogContent>
    </Dialog>
  );
}

function FileViewerBody({
  kind,
  title,
  state,
  downloadFailed,
  onDownload,
  allowScripts,
}: {
  kind: FileViewerKind;
  title: string;
  state: BodyState;
  downloadFailed: boolean;
  onDownload: () => void;
  allowScripts: boolean;
}) {
  if (state.phase === "loading") {
    return (
      <div
        data-testid="file-viewer-loading"
        className="flex h-full min-h-40 items-center justify-center"
      >
        <Spinner className="h-6 w-6" />
      </div>
    );
  }
  if (state.phase === "error") {
    return (
      <div
        data-testid="file-viewer-error"
        className="flex h-full min-h-40 flex-col items-center justify-center gap-3 text-center"
      >
        <FileText
          className="h-8 w-8 text-muted-foreground"
          aria-hidden="true"
        />
        <p className="text-sm text-muted-foreground">{state.message}</p>
        {downloadFailed ? (
          <p className="text-xs text-muted-foreground">
            The download attempt failed too.
          </p>
        ) : (
          <button
            type="button"
            onClick={onDownload}
            className="flex items-center gap-1.5 rounded-md border border-border/70 px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            Try downloading instead
          </button>
        )}
      </div>
    );
  }

  const { src, text } = state;
  switch (kind) {
    case "image":
      return (
        <div
          data-testid="file-viewer-body"
          className="flex h-full min-h-0 items-center justify-center overflow-auto"
        >
          <img
            src={src}
            alt={title}
            className="mx-auto max-h-full max-w-full object-contain"
          />
        </div>
      );
    case "video":
      return (
        <div
          data-testid="file-viewer-body"
          className="flex h-full min-h-0 items-center justify-center"
        >
          {/* biome-ignore lint/a11y/useMediaCaption: viewer surfaces posted files; uploads carry no caption tracks */}
          <video src={src} controls className="max-h-full w-full" />
        </div>
      );
    case "audio":
      return (
        <div
          data-testid="file-viewer-body"
          className="flex h-full min-h-0 items-center justify-center"
        >
          {/* biome-ignore lint/a11y/useMediaCaption: viewer surfaces posted files; uploads carry no caption tracks */}
          <audio src={src} controls className="w-full" />
        </div>
      );
    case "pdf":
      return (
        <iframe
          data-testid="file-viewer-body"
          src={src}
          title={title}
          className="h-full w-full rounded-lg border border-border/60 bg-background"
        />
      );
    case "html":
      // Sandbox, two tiers. OUR OWN relay-served edition pages run their tab
      // script in an OPAQUE origin (allow-scripts, no allow-same-origin — the
      // page can toggle tabs but reaches none of the SPA's origin state).
      // Everything else stays allow-same-origin with scripts off: no code
      // execution from stranger files, no top navigation from anything.
      return (
        <iframe
          data-testid="file-viewer-body"
          src={src}
          title={title}
          sandbox={allowScripts ? "allow-scripts" : "allow-same-origin"}
          className="h-full w-full rounded-lg border border-border/60 bg-background"
        />
      );
    case "markdown":
      return (
        <div
          data-testid="file-viewer-body"
          className="message-prose prose dark:prose-invert h-full min-h-0 max-w-none overflow-auto break-words"
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {text ?? ""}
          </ReactMarkdown>
        </div>
      );
    case "text":
      return (
        <pre
          data-testid="file-viewer-body"
          className="h-full min-h-0 overflow-auto rounded-lg bg-muted/40 p-4 font-mono text-xs leading-relaxed"
        >
          {text ?? ""}
        </pre>
      );
    case "fallback":
      return (
        <div
          data-testid="file-viewer-body"
          className="flex h-full min-h-40 flex-col items-center justify-center gap-3 text-center"
        >
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-muted/40 text-muted-foreground">
            <FileText className="h-6 w-6" aria-hidden="true" />
          </span>
          <div>
            <p className="text-sm font-medium">{title}</p>
            <p className="text-xs text-muted-foreground">
              No in-app preview for this file type
            </p>
          </div>
          <button
            type="button"
            onClick={onDownload}
            className="flex items-center gap-1.5 rounded-md border border-border/70 px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            Download
          </button>
        </div>
      );
  }
}
