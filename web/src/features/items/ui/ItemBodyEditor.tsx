import { Paperclip } from "lucide-react";
import { useId, useLayoutEffect, useRef } from "react";
import { ATTACHMENT_ACCEPT } from "@/features/channels/lib/attachmentAccept.ts";
import { removeAttachmentMarkdown } from "@/features/channels/lib/attachmentMarkdown.ts";
import { ComposerAttachmentTray } from "@/features/channels/ui/ComposerAttachmentTray";
import { useComposerAttachments } from "@/features/channels/ui/useComposerAttachments";
import { ITEM_BODY_MAX_BYTES } from "../lib/itemEvent.ts";
import {
  insertItemAttachment,
  itemAttachmentMarkdown,
  itemAttachmentUrl,
  itemBodyBytes,
} from "../lib/itemAttachments.ts";

/** A markdown body using the channel composer's upload transport, queue and tray. */
export function ItemBodyEditor({
  value,
  onChange,
  busy,
  onPendingChange,
}: {
  value: string;
  onChange: (body: string) => void;
  busy: boolean;
  onPendingChange: (pending: boolean) => void;
}) {
  const id = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const latestBody = useRef(value);
  latestBody.current = value;
  const caret = useRef<number | null>(null);
  const uploads = useComposerAttachments({
    initial: () => [],
    editingActive: false,
    busy,
    pasteFiles: true,
    onUploaded: (descriptor, row) => {
      const input = textarea.current;
      const inserted = insertItemAttachment(
        latestBody.current,
        input?.selectionStart ?? latestBody.current.length,
        input?.selectionEnd ?? latestBody.current.length,
        itemAttachmentMarkdown(descriptor, row.name),
      );
      latestBody.current = inserted.body;
      caret.current = inserted.cursor;
      onChange(inserted.body);
    },
  });
  useLayoutEffect(() => {
    onPendingChange(uploads.uploadsPending);
  }, [uploads.uploadsPending, onPendingChange]);
  useLayoutEffect(() => {
    if (caret.current === null) return;
    textarea.current?.focus();
    textarea.current?.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  });
  const bytes = itemBodyBytes(value);
  return (
    <div
      {...uploads.dropHandlers}
      className="relative flex flex-col gap-1.5"
      data-testid="item-body-editor"
    >
      <label htmlFor={id} className="text-xs font-semibold text-ink-2">
        Description{" "}
        <span className="font-normal text-muted-foreground">(optional)</span>
      </label>
      <textarea
        id={id}
        ref={textarea}
        value={value}
        disabled={busy}
        rows={4}
        placeholder="Explain it here. Paste or drop files to attach them."
        onChange={(event) => {
          latestBody.current = event.target.value;
          onChange(event.target.value);
        }}
        onPaste={uploads.onPaste}
        className="w-full resize-y rounded-lg border border-border bg-card px-3 py-2 text-sm outline-hidden placeholder:text-muted-foreground focus:border-foreground"
        aria-invalid={bytes > ITEM_BODY_MAX_BYTES}
        aria-describedby={`${id}-size`}
      />
      <input
        ref={uploads.fileInputRef}
        type="file"
        multiple
        accept={ATTACHMENT_ACCEPT}
        className="hidden"
        aria-label="Attach files"
        disabled={busy}
        onChange={(event) => {
          void uploads.attach(event.target.files);
        }}
      />
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => uploads.fileInputRef.current?.click()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-semibold hover:bg-accent disabled:opacity-50"
        >
          <Paperclip aria-hidden className="size-3.5" />
          Attach
        </button>
        <span
          id={`${id}-size`}
          className={`text-2xs ${bytes > ITEM_BODY_MAX_BYTES ? "text-destructive" : "text-muted-foreground"}`}
        >
          {bytes} / {ITEM_BODY_MAX_BYTES} bytes
        </span>
      </div>
      <ComposerAttachmentTray
        attachments={uploads.attachments}
        onRemove={(id) => {
          const row = uploads.attachments.find((entry) => entry.id === id);
          if (row?.descriptor) {
            const url = itemAttachmentUrl(row.descriptor.url);
            const next = removeAttachmentMarkdown(latestBody.current, url);
            latestBody.current = next;
            onChange(next);
          }
          uploads.removeQueued(id);
        }}
      />
      {uploads.dragDepth > 0 ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg border-2 border-dashed border-primary bg-card/90 text-sm font-semibold">
          Drop files to attach
        </div>
      ) : null}
    </div>
  );
}
