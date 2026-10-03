import { useId, useState } from "react";

import type { ChannelSummary } from "@/features/channels/useChannels";
import { cn } from "@/shared/lib/cn";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import {
  charCount,
  ITEM_PROJECT_NAME_MAX_CHARS,
  ITEM_BODY_MAX_BYTES,
  ITEM_SUMMARY_MAX_CHARS,
  ITEM_TITLE_MAX_CHARS,
  type ItemType,
  rustTrim,
} from "../lib/itemEvent.ts";
import { itemBodyBytes } from "../lib/itemAttachments.ts";
import { ItemBodyEditor } from "./ItemBodyEditor";

const FIELD =
  "w-full rounded-lg border border-border bg-card px-3 text-sm outline-hidden placeholder:text-muted-foreground focus:border-foreground";

/**
 * "Add item" from the Items page header. No conversation is open here, so
 * there is no source message and no confirmation row; picking a channel
 * scopes who can see it (D5.2), and "No channel" files it for everyone.
 */
export function AddItemDialog({
  open,
  channels,
  projects,
  onClose,
  onCreate,
}: {
  open: boolean;
  /** Streams and forums the item can be filed in (DMs are for `/bug`). */
  channels: readonly ChannelSummary[];
  /** Project labels already in use, offered as suggestions. */
  projects: readonly string[];
  onClose: () => void;
  onCreate: (input: {
    type: ItemType;
    title: string;
    summary: string | null;
    body: string;
    channelId: string | null;
    projectName: string | null;
  }) => Promise<string | null>;
}) {
  const ids = useId();
  const [type, setType] = useState<ItemType>("bug");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [body, setBody] = useState("");
  const [uploadsPending, setUploadsPending] = useState(false);
  const [channelId, setChannelId] = useState("");
  const [project, setProject] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const reset = () => {
    setTitle("");
    setSummary("");
    setBody("");
    setUploadsPending(false);
    setProject("");
    setError(null);
  };
  const close = () => {
    reset();
    onClose();
  };
  const titleChars = charCount(rustTrim(title));
  const submit = async () => {
    if (saving || uploadsPending) return;
    if (itemBodyBytes(body) > ITEM_BODY_MAX_BYTES) {
      setError(`Keep the description to ${ITEM_BODY_MAX_BYTES} bytes.`);
      return;
    }
    if (titleChars === 0) {
      setError("Give it a title.");
      return;
    }
    if (titleChars > ITEM_TITLE_MAX_CHARS) {
      setError(
        `Keep the title to ${ITEM_TITLE_MAX_CHARS} characters — this one is ${titleChars}.`,
      );
      return;
    }
    if (charCount(summary.trim()) > ITEM_SUMMARY_MAX_CHARS) {
      setError(`Keep the summary to ${ITEM_SUMMARY_MAX_CHARS} characters.`);
      return;
    }
    if (charCount(project.trim()) > ITEM_PROJECT_NAME_MAX_CHARS) {
      setError(
        `Keep the project name to ${ITEM_PROJECT_NAME_MAX_CHARS} characters.`,
      );
      return;
    }
    setSaving(true);
    const failure = await onCreate({
      type,
      title: rustTrim(title),
      summary: summary.trim() === "" ? null : summary.trim(),
      body,
      channelId: channelId === "" ? null : channelId,
      projectName: project.trim() === "" ? null : project.trim(),
    });
    setSaving(false);
    if (failure === null) {
      close();
    } else {
      setError(failure);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
      <DialogContent
        className="max-h-[90dvh] max-w-lg gap-4 overflow-y-auto"
        data-testid="add-item-dialog"
      >
        <DialogHeader>
          <DialogTitle className="text-lg">Add item</DialogTitle>
          <DialogDescription>
            In a conversation, <span className="font-mono">/bug</span> and{" "}
            <span className="font-mono">/backlog</span> do this and link the
            message.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <fieldset className="flex w-fit rounded-[9px] bg-chip p-0.5">
            <legend className="sr-only">Type</legend>
            {(["bug", "backlog"] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={type === option}
                onClick={() => setType(option)}
                className={cn(
                  "h-7 rounded-[7px] px-3 text-xs font-semibold",
                  type === option
                    ? "bg-card text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {option === "bug" ? "Bug" : "Backlog"}
              </button>
            ))}
          </fieldset>
          <label className="flex flex-col gap-1.5 text-xs font-semibold text-ink-2">
            Title
            <input
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
                setError(null);
              }}
              placeholder={
                type === "bug"
                  ? "What broke, in one line"
                  : "What to build, in one line"
              }
              className={cn(FIELD, "h-9 font-normal text-foreground")}
            />
            {titleChars > ITEM_TITLE_MAX_CHARS - 20 ? (
              <span className="font-mono text-2xs font-normal text-muted-foreground">
                {titleChars} / {ITEM_TITLE_MAX_CHARS}
              </span>
            ) : null}
          </label>
          <label className="flex flex-col gap-1.5 text-xs font-semibold text-ink-2">
            Summary{" "}
            <span className="font-normal text-muted-foreground">
              (optional — the line people read in the list)
            </span>
            <textarea
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
              rows={2}
              className={cn(
                FIELD,
                "resize-none py-2 font-normal text-foreground",
              )}
            />
          </label>
          {open ? (
            <ItemBodyEditor
              value={body}
              onChange={setBody}
              busy={saving}
              onPendingChange={setUploadsPending}
            />
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5 text-xs font-semibold text-ink-2">
              Channel
              <select
                value={channelId}
                onChange={(event) => setChannelId(event.target.value)}
                className={cn(FIELD, "h-9 font-normal text-foreground")}
              >
                <option value="">No channel — everyone sees it</option>
                {channels.map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    #{channel.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5 text-xs font-semibold text-ink-2">
              Project <span className="sr-only">(optional)</span>
              <input
                value={project}
                onChange={(event) => setProject(event.target.value)}
                list={`${ids}-projects`}
                placeholder="Optional"
                className={cn(FIELD, "h-9 font-normal text-foreground")}
              />
              <datalist id={`${ids}-projects`}>
                {projects.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </label>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <button
              type="button"
              onClick={close}
              className="h-9 rounded-lg border border-border px-3.5 text-sm font-semibold hover:bg-accent"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={
                saving ||
                uploadsPending ||
                itemBodyBytes(body) > ITEM_BODY_MAX_BYTES
              }
              className="h-9 rounded-lg bg-primary px-3.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {uploadsPending
                ? "Uploading…"
                : saving
                  ? "Adding…"
                  : type === "bug"
                    ? "File bug"
                    : "Add to backlog"}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
