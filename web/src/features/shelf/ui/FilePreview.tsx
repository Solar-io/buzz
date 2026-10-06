import { Download, FolderOpen, Link2, Pencil, RotateCw, X } from "lucide-react";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { formatFileSize } from "@/features/channels/lib/messageMedia.ts";
import { useFileDownload } from "@/features/channels/ui/FileCard";
import { getConfiguredFilesUrl } from "@/features/files/filesConfig";
import { openInFiles } from "@/features/webPanels/filesPathStore";
import { cn } from "@/shared/lib/cn";
import { publicAppOrigin } from "@/shared/lib/relay-url";
import { useFileTabs } from "../FileTabsProvider";
import { editedSinceShared, reasonText } from "../lib/diskDocument.ts";
import { cleanQuote } from "../lib/fileComment.ts";
import {
  fileKind,
  hasSourceView,
  kindLabel,
  previewMode,
  readMinutes,
  readsText,
  sourceLanguage,
} from "../lib/fileKind.ts";
import type { OpenFile } from "../lib/fileTabs.ts";
import { whenLabel } from "../lib/shelfView.ts";
import {
  displayPath,
  filesTarget,
  parseSharePath,
  type SharePath,
} from "../lib/shareEvent.ts";
import { useShelf } from "../ShelfProvider";
import { useFileComments } from "../useFileComments.ts";
import { useDiskDocument } from "../useDiskDocument.ts";
import { useDiskTrusted } from "../useDiskTrusted.ts";
import { type FileContent, useFileContent } from "../useFileContent.ts";
import { useShareNames } from "../useShareNames.ts";
import { AgentBox, FileThread } from "./FileComments";
import { FileEditor } from "./FileEditor";
import { FilePreviewBody } from "./FilePreviewBody";

function ActionButton({
  label,
  icon,
  onClick,
  testId,
  compact,
}: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  testId: string;
  /** The phone sheet: a 36 px icon button, its label as its name. */
  compact: boolean;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      aria-label={compact ? label : undefined}
      title={compact ? label : undefined}
      className={cn(
        "inline-flex shrink-0 items-center rounded-lg border border-line-2 bg-card text-xs font-semibold text-foreground transition-colors hover:bg-accent",
        compact ? "size-9 justify-center" : "h-7.5 gap-1.5 px-2.5",
      )}
    >
      {icon}
      {compact ? null : label}
    </button>
  );
}

/** The file's path, from the tab or (for a cached message) the Shelf's copy. */
function useSharePath(file: OpenFile): SharePath | null {
  const shelf = useShelf();
  return useMemo(() => {
    const own = parseSharePath(file.path);
    if (own || !file.messageId) {
      return own;
    }
    const share = shelf?.byId.get(file.messageId);
    return share?.files.find((entry) => entry.url === file.url)?.path ?? null;
  }, [file.path, file.messageId, file.url, shelf]);
}

/**
 * The shared bytes' sha256, from the tab or — for a tab opened before the
 * field existed, or a tile on a cached message — the Shelf's copy (healed
 * like `path`, AGENTS.md "heal in the same commit").
 */
function useShareSha256(file: OpenFile): string | null {
  const shelf = useShelf();
  return useMemo(() => {
    const own = file.sha256 ?? null;
    if (own || !file.messageId) {
      return own;
    }
    const share = shelf?.byId.get(file.messageId);
    return share?.files.find((entry) => entry.url === file.url)?.sha256 ?? null;
  }, [file.sha256, file.messageId, file.url, shelf]);
}

/**
 * A file open beside the conversation (Preview and Shelf artboards): what it
 * is and where it came from, Preview / Source, the actions (Jump to message,
 * Open in Files when the share carried a path on the Files host, Download,
 * Copy link), the preview, and the agent thread — thread replies to the
 * share — with the agent box at the foot.
 *
 * Canvas edit (`~/.buzz/PLANS/CANVAS_EDIT_AGENT_BOX.md`): when the share's
 * path is on the Files host and stash lets this browser read it, the pane
 * previews the DISK file ("Live · crichton"), offers Edit, and follows the
 * agent's later edits; otherwise it is the shared snapshot, read-only, with
 * the reason. The relay blob is never edited.
 *
 * `variant`: the docked tab, the tab expanded over the row, or the phone's
 * full-screen sheet (which brings its own close).
 */
export function FilePreview({
  file,
  variant,
  onClose,
}: {
  file: OpenFile;
  variant: "dock" | "expanded" | "sheet";
  /** The sheet's close (the dock closes from its tab). */
  onClose?: () => void;
}) {
  const tabs = useFileTabs();
  const kind = fileKind(file.filename, file.mime);
  const mode = previewMode(file.filename, kind);
  const [view, setView] = useState<"preview" | "source">("preview");
  const [reload, setReload] = useState(0);
  const [quote, setQuote] = useState<string | null>(null);
  const content = useFileContent(file.url, mode, file.size, reload);
  const { download } = useFileDownload(file.url, file.filename);
  const path = useSharePath(file);
  const filesUrl = getConfiguredFilesUrl();
  const filesPath = filesTarget(path, filesUrl);
  const sha256 = useShareSha256(file);
  const share =
    file.messageId && file.channelId && file.authorPubkey
      ? {
          id: file.messageId,
          channelId: file.channelId,
          authorPubkey: file.authorPubkey,
          rootId: file.rootId,
          replyToId: file.replyToId,
        }
      : null;
  const { comments } = useFileComments(share);
  const people = useMemo(
    () => [
      ...new Set([
        ...(file.authorPubkey ? [file.authorPubkey] : []),
        ...comments.map((comment) => comment.authorPubkey),
      ]),
    ],
    [file.authorPubkey, comments],
  );
  const names = useShareNames(people);
  // Registry-only trust for disk access — NOT names.isAgent (useDiskTrusted.ts).
  const trusted = useDiskTrusted(file.authorPubkey);
  const disk = useDiskDocument(path, filesUrl, trusted);
  const [viewShared, setViewShared] = useState(false);
  const live =
    disk.state.phase === "live" && disk.state.live ? disk.state.live : null;
  const showingLive = live !== null && !viewShared;
  const shown: FileContent =
    showingLive && readsText(mode)
      ? { phase: "text", text: live.content }
      : content;
  const edited = editedSinceShared(live?.digest, sha256);
  const editing = disk.state.editing !== null;
  const bodyRef = useRef<HTMLDivElement>(null);
  const compact = variant === "sheet";

  const meta = [
    file.size !== null ? formatFileSize(file.size) : null,
    kindLabel(kind).toLowerCase(),
    mode === "markdown" && shown.phase === "text"
      ? `${readMinutes(shown.text)} min read`
      : null,
  ].filter(Boolean);
  const leave = () => {
    if (variant === "sheet") {
      onClose?.();
    }
  };
  const copyLink = () => {
    if (!file.channelId || !file.messageId) {
      return;
    }
    const url = `${publicAppOrigin()}/repos?c=${file.channelId}&m=${file.messageId}`;
    void navigator.clipboard
      ?.writeText(url)
      .then(() => toast.success("Link copied"))
      .catch(() => toast.error("Could not copy the link."));
  };
  const captureSelection = () => {
    const selection = globalThis.getSelection?.();
    const root = bodyRef.current;
    if (!selection || selection.isCollapsed || !root) {
      return;
    }
    if (!root.contains(selection.anchorNode)) {
      return;
    }
    const next = cleanQuote(selection.toString());
    if (next) {
      setQuote(next);
    }
  };

  return (
    <section
      data-testid="file-preview"
      data-variant={variant}
      aria-label={file.filename}
      className="flex h-full min-h-0 flex-col bg-background"
    >
      <header className="border-b border-border px-4 pt-3 pb-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
              <h2
                data-testid="file-preview-name"
                className="max-w-full truncate font-mono text-sm font-semibold"
              >
                {file.filename}
              </h2>
              <span className="shrink-0 font-mono text-2xs text-muted-foreground">
                {meta.join(" · ")}
              </span>
            </div>
            {file.authorPubkey && file.channelId && file.createdAt ? (
              <p className="mt-0.5 text-xs text-muted-foreground">
                Shared by {names.person(file.authorPubkey)} in{" "}
                {names.channel(file.channelId)} ·{" "}
                {whenLabel(file.createdAt, Math.floor(Date.now() / 1000))}
                {file.messageId ? (
                  <>
                    {" · "}
                    <button
                      type="button"
                      data-testid="file-jump"
                      onClick={() => {
                        leave();
                        tabs?.openMessage(
                          file.channelId as string,
                          file.messageId as string,
                        );
                      }}
                      className="font-semibold text-info-ink hover:underline"
                    >
                      Jump to message
                    </button>
                  </>
                ) : null}
              </p>
            ) : null}
            {path ? (
              <p
                data-testid="file-preview-path"
                className="mt-0.5 truncate font-mono text-2xs text-muted-foreground"
                title={`${path.host}:${path.path}`}
              >
                {disk.state.phase === "live" || disk.state.phase === "locating"
                  ? `${path.host}:${path.path}`
                  : `${path.host}: ${displayPath(path.path)}`}
              </p>
            ) : null}
            {disk.state.phase !== "off" ? (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-2xs">
                <span
                  data-testid="file-version-chip"
                  className={cn(
                    "rounded-full px-2 py-0.5 font-semibold",
                    showingLive
                      ? "bg-info-soft text-info-ink"
                      : "bg-chip text-muted-foreground",
                  )}
                >
                  {showingLive && path
                    ? `Live · ${path.host}`
                    : disk.state.phase === "locating"
                      ? "Checking Files…"
                      : "Shared snapshot"}
                </span>
                {edited ? (
                  <>
                    <span
                      data-testid="file-edited-since-shared"
                      className="rounded-full bg-honey-wash px-2 py-0.5 font-semibold text-honey-ink"
                    >
                      Edited since shared
                    </span>
                    {editing ? null : (
                      <button
                        type="button"
                        data-testid="file-view-shared"
                        onClick={() => setViewShared((value) => !value)}
                        className="min-h-11 font-semibold text-info-ink hover:underline md:min-h-0"
                      >
                        {viewShared
                          ? "View live version"
                          : "View shared version"}
                      </button>
                    )}
                  </>
                ) : null}
              </div>
            ) : null}
            {disk.state.phase === "readonly" && disk.state.reason ? (
              <p
                data-testid="file-readonly-reason"
                className="mt-1 text-xs text-muted-foreground"
              >
                {reasonText(disk.state.reason, path?.host)}
                {disk.state.reason === "signed-out" && filesPath ? (
                  <>
                    {" · "}
                    <button
                      type="button"
                      onClick={() => {
                        leave();
                        openInFiles(filesPath);
                      }}
                      className="font-semibold text-info-ink hover:underline"
                    >
                      Open Files
                    </button>
                  </>
                ) : null}
                {disk.state.orphanDraft !== null ? (
                  <>
                    {" · "}
                    <button
                      type="button"
                      data-testid="file-copy-orphan-draft"
                      onClick={() =>
                        void navigator.clipboard
                          ?.writeText(disk.state.orphanDraft ?? "")
                          .then(() => toast.success("Draft copied"))
                      }
                      className="font-semibold text-info-ink hover:underline"
                    >
                      Copy my unsaved draft
                    </button>
                  </>
                ) : null}
              </p>
            ) : null}
          </div>
          {variant === "sheet" ? (
            <button
              type="button"
              aria-label="Close file"
              onClick={onClose}
              className="-mt-1 -mr-1.5 grid size-9 shrink-0 place-items-center rounded-lg text-ink-2 hover:bg-accent"
            >
              <X aria-hidden className="size-4.5" />
            </button>
          ) : null}
        </div>
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {hasSourceView(mode) && !editing ? (
            <fieldset className="flex rounded-lg bg-chip p-0.5">
              <legend className="sr-only">View</legend>
              {(["preview", "source"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={view === option}
                  data-testid={`file-view-${option}`}
                  onClick={() => setView(option)}
                  className={cn(
                    "rounded-md text-xs font-semibold capitalize",
                    compact ? "h-8 px-3" : "h-6 px-2.5",
                    view === option
                      ? "bg-card text-foreground shadow-xs"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {option}
                </button>
              ))}
            </fieldset>
          ) : null}
          {mode === "html" && view === "preview" ? (
            <button
              type="button"
              aria-label="Reload preview"
              onClick={() => setReload((value) => value + 1)}
              className="grid size-7 place-items-center rounded-lg text-ink-2 hover:bg-accent"
            >
              <RotateCw aria-hidden className="size-3.5" />
            </button>
          ) : null}
          <span className="ml-auto" />
          {showingLive && !editing ? (
            <ActionButton
              compact={compact}
              testId="file-edit"
              label="Edit"
              icon={<Pencil aria-hidden className="size-3.5" />}
              onClick={disk.edit}
            />
          ) : null}
          {filesPath ? (
            <ActionButton
              compact={compact}
              testId="file-open-in-files"
              label="Open in Files"
              icon={<FolderOpen aria-hidden className="size-3.5" />}
              onClick={() => {
                leave();
                openInFiles(filesPath);
              }}
            />
          ) : null}
          <ActionButton
            compact={compact}
            testId="file-download"
            label="Download"
            icon={<Download aria-hidden className="size-3.5" />}
            onClick={download}
          />
          {file.messageId ? (
            <ActionButton
              compact={compact}
              testId="file-copy-link"
              label="Copy link"
              icon={<Link2 aria-hidden className="size-3.5" />}
              onClick={copyLink}
            />
          ) : null}
        </div>
      </header>
      <div
        data-testid="file-preview-scroll"
        className="buzz-content-scrollbar min-h-0 flex-1 overflow-y-auto"
      >
        {/* biome-ignore lint/a11y/noStaticElementInteractions: reads a text selection for the comment box; nothing to activate */}
        <div
          ref={bodyRef}
          onMouseUp={captureSelection}
          onKeyUp={captureSelection}
          className={cn(
            "px-4 py-4",
            variant !== "dock" && "mx-auto w-full max-w-5xl",
          )}
        >
          {editing ? (
            <FileEditor
              disk={disk}
              canPreview={hasSourceView(mode)}
              compact={compact}
              renderPreview={(draft) => (
                <FilePreviewBody
                  content={{ phase: "text", text: draft }}
                  mode={mode}
                  view="preview"
                  filename={file.filename}
                  language={
                    mode === "code" ? sourceLanguage(file.filename) : ""
                  }
                  fit={variant === "dock" ? "dock" : "fill"}
                  reloadKey={reload}
                  onDownload={download}
                />
              )}
            />
          ) : (
            <FilePreviewBody
              content={shown}
              mode={mode}
              view={view}
              filename={file.filename}
              language={
                view === "source" || mode === "code"
                  ? sourceLanguage(file.filename)
                  : ""
              }
              fit={variant === "dock" ? "dock" : "fill"}
              reloadKey={reload}
              onDownload={download}
            />
          )}
        </div>
        <div className={cn(variant !== "dock" && "mx-auto w-full max-w-5xl")}>
          <FileThread comments={comments} names={names} />
        </div>
      </div>
      {share ? (
        <AgentBox
          share={share}
          quote={quote}
          onClearQuote={() => setQuote(null)}
          selfPubkey={names.selfPubkey}
          names={names}
          comments={comments}
          context={{
            filename: file.filename,
            path: path ? `${path.host}:${path.path}` : null,
            editedSinceShared: edited,
          }}
          dirty={disk.dirty}
          saveDraft={disk.save}
          className={cn(
            variant === "sheet" &&
              "pb-[max(0.875rem,env(safe-area-inset-bottom))]",
          )}
        />
      ) : null}
    </section>
  );
}
