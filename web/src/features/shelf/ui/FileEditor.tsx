import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";

import { cn } from "@/shared/lib/cn";
import { Textarea } from "@/shared/ui/textarea";
import type { DiskDocument } from "../useDiskDocument.ts";

const BUTTON =
  "inline-flex min-h-11 shrink-0 items-center justify-center rounded-lg px-3 text-xs font-semibold transition-colors disabled:opacity-40 md:min-h-7.5";

function confirmDiscard(): boolean {
  return globalThis.confirm?.("Discard your unsaved edits?") ?? true;
}

function copyDraft(draft: string): void {
  void navigator.clipboard
    ?.writeText(draft)
    .then(() => toast.success("Draft copied"))
    .catch(() => toast.error("Could not copy the draft."));
}

/**
 * Editing a shared file on disk (canvas edit plan D13): a plain monospace
 * Textarea — the channel canvas editor's component and pattern — with a
 * Preview tab for rendered kinds, Save / Cancel, ⌘S and Esc, the "changed on
 * disk" banner while the draft is dirty, and the three-way 409 panel.
 * No autosave: the disk changes only on Save.
 */
export function FileEditor({
  disk,
  canPreview,
  renderPreview,
  compact,
}: {
  disk: DiskDocument;
  /** The kind has a rendered view (markdown, HTML, CSV): offer Preview. */
  canPreview: boolean;
  renderPreview: (draft: string) => ReactNode;
  compact: boolean;
}) {
  const { state, dirty } = disk;
  const editing = state.editing;
  const [tab, setTab] = useState<"edit" | "preview">("edit");
  const [bannerHidden, setBannerHidden] = useState(false);
  const changedAt = state.changedOnDisk?.digest ?? null;
  // A NEW disk version re-raises the banner the person dismissed.
  useEffect(() => {
    if (changedAt !== null) {
      setBannerHidden(false);
    }
  }, [changedAt]);

  if (!editing) {
    return null;
  }

  const cancel = () => {
    if (dirty && !confirmDiscard()) {
      return;
    }
    disk.cancel();
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: ⌘S / Esc for the editor inside
    <div
      data-testid="file-editor"
      className="flex flex-col gap-2"
      onKeyDown={(event) => {
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === "s"
        ) {
          event.preventDefault();
          if (dirty && !state.saving) {
            void disk.save();
          }
        } else if (event.key === "Escape") {
          event.preventDefault();
          cancel();
        }
      }}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {canPreview ? (
          <fieldset className="flex rounded-lg bg-chip p-0.5">
            <legend className="sr-only">Editor view</legend>
            {(["edit", "preview"] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={tab === option}
                data-testid={`file-editor-${option}`}
                onClick={() => setTab(option)}
                className={cn(
                  "rounded-md text-xs font-semibold capitalize",
                  compact ? "min-h-11 px-3" : "h-6 px-2.5",
                  tab === option
                    ? "bg-card text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {option}
              </button>
            ))}
          </fieldset>
        ) : null}
        <span
          role="status"
          data-testid="file-editor-status"
          className="ml-auto text-xs text-muted-foreground"
        >
          {state.saving
            ? "Saving…"
            : state.saved && !dirty
              ? "Saved"
              : dirty
                ? "Unsaved changes"
                : ""}
        </span>
        <button
          type="button"
          data-testid="file-editor-cancel"
          onClick={cancel}
          className={cn(BUTTON, "border border-line-2 bg-card hover:bg-accent")}
        >
          {dirty ? "Cancel" : "Done"}
        </button>
        <button
          type="button"
          data-testid="file-editor-save"
          disabled={!dirty || state.saving}
          onClick={() => void disk.save()}
          className={cn(BUTTON, "bg-primary text-primary-foreground")}
        >
          Save
        </button>
      </div>
      {state.saveError ? (
        <p
          role="alert"
          data-testid="file-editor-error"
          className="text-sm text-coral-ink"
        >
          {state.saveError}
        </p>
      ) : null}
      {state.conflict ? (
        <div
          role="alert"
          data-testid="file-editor-conflict"
          className="flex flex-col gap-2 rounded-lg border border-coral-line bg-coral-wash px-3 py-2.5 text-sm"
        >
          <p>
            Not saved — this file changed on disk after you opened it. Nothing
            was overwritten.
          </p>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              data-testid="file-conflict-theirs"
              onClick={() => {
                if (confirmDiscard()) {
                  void disk.showTheirs();
                }
              }}
              className={cn(
                BUTTON,
                "border border-line-2 bg-card hover:bg-accent",
              )}
            >
              Show their version
            </button>
            <button
              type="button"
              data-testid="file-conflict-overwrite"
              disabled={state.saving}
              onClick={() => void disk.overwrite()}
              className={cn(BUTTON, "bg-coral-ink text-background")}
            >
              Overwrite their version
            </button>
            <button
              type="button"
              data-testid="file-conflict-copy"
              onClick={() => copyDraft(editing.draft)}
              className={cn(
                BUTTON,
                "border border-line-2 bg-card hover:bg-accent",
              )}
            >
              Copy my draft
            </button>
          </div>
        </div>
      ) : state.changedOnDisk && dirty && !bannerHidden ? (
        <div
          role="status"
          data-testid="file-editor-changed"
          className="flex flex-wrap items-center gap-2 rounded-lg border border-honey-line bg-honey-wash px-3 py-2 text-sm"
        >
          <span className="min-w-0 flex-1">
            This file changed on disk while you were editing.
          </span>
          <button
            type="button"
            onClick={() => {
              if (confirmDiscard()) {
                void disk.showTheirs();
              }
            }}
            className={cn(
              BUTTON,
              "border border-line-2 bg-card hover:bg-accent",
            )}
          >
            Load their version
          </button>
          <button
            type="button"
            onClick={() => setBannerHidden(true)}
            className={cn(BUTTON, "hover:bg-accent")}
          >
            Keep editing
          </button>
        </div>
      ) : null}
      {tab === "preview" && canPreview ? (
        <div data-testid="file-editor-preview">
          {renderPreview(editing.draft)}
        </div>
      ) : (
        <Textarea
          data-testid="file-editor-input"
          aria-label="File contents"
          autoFocus
          spellCheck
          value={editing.draft}
          disabled={state.saving}
          onChange={(event) => disk.change(event.target.value)}
          className="min-h-80 resize-y font-mono"
        />
      )}
    </div>
  );
}
