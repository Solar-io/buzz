import { useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { toast } from "@/shared/ui/notify";
import { uploadBlob } from "@/shared/api/blossom";
import { attachmentRejectionReason } from "../lib/attachmentAccept.ts";
import { dragCarriesFiles, partitionDropFiles } from "../lib/attachmentDrop.ts";
import {
  hasPendingUploads,
  markFailed,
  markUploaded,
  markUploading,
  queuedFrom,
  removeAttachment,
  withProgress,
  type QueuedAttachment,
} from "../lib/attachmentQueue.ts";
import { imageFilesFromClipboard } from "../lib/composerPaste.ts";

/**
 * The composer's attachment queue and its three entry points — the picker,
 * a pasted screenshot and a drag-and-drop — lifted out of `Composer.tsx`
 * unchanged (web redesign Phase 2: the composer needed the room for slash
 * commands and sits under the 1000-line ceiling).
 *
 * The queue itself stays composer state in spirit: draft persistence and
 * submit both read it, so the hook hands back the list and its setter.
 */
export function useComposerAttachments(options: {
  initial: () => QueuedAttachment[];
  /** No drop or paste mid-edit (the tray belongs to the channel draft). */
  editingActive: boolean;
  /** …and no drop mid-send. */
  busy: boolean;
}) {
  const { editingActive, busy } = options;
  const [attachments, setAttachments] = useState<QueuedAttachment[]>(
    options.initial,
  );
  const fileInputRef = useRef<HTMLInputElement>(null);

  /**
   * Queue and upload files one at a time, each with its own row in the tray.
   *
   * Sequential rather than parallel on purpose: the relay's upload path takes
   * a per-pubkey in-flight permit, and a serial queue makes the per-file
   * progress bars mean what they appear to mean.
   */
  const attachFiles = async (files: File[]) => {
    const accepted: { file: File; row: QueuedAttachment }[] = [];
    for (const file of files) {
      const reason = attachmentRejectionReason(file);
      if (reason) {
        toast.error(`${file.name}: ${reason}`);
        continue;
      }
      const previewUrl = file.type.startsWith("image/")
        ? URL.createObjectURL(file)
        : undefined;
      accepted.push({ file, row: queuedFrom(file, previewUrl) });
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
    if (accepted.length === 0) {
      return;
    }
    setAttachments((previous) => [
      ...previous,
      ...accepted.map((entry) => entry.row),
    ]);
    for (const { file, row } of accepted) {
      setAttachments((previous) => markUploading(previous, row.id));
      try {
        const descriptor = await uploadBlob(file, {
          onProgress: (fraction) =>
            setAttachments((previous) =>
              withProgress(previous, row.id, fraction),
            ),
        });
        setAttachments((previous) =>
          markUploaded(previous, row.id, descriptor),
        );
        // No text mutation: the markdown is composed at send time
        // (`composeSendContent` in submit) — the box shows only what the
        // author typed (Sam, 2026-09-17: hide attachment URLs in the box).
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Upload failed.";
        setAttachments((previous) => markFailed(previous, row.id, message));
        toast.error(`${file.name}: ${message}`);
      }
    }
  };

  const attach = async (files: FileList | null) => {
    if (!files || files.length === 0) {
      return;
    }
    await attachFiles(Array.from(files));
  };

  /** Drop one attachment and its preview. No text to unwind — the box never
   *  carried the attachment's markdown; dropping the chip drops the wire. */
  const removeQueued = (id: string) => {
    const item = attachments.find((entry) => entry.id === id);
    setAttachments((previous) => removeAttachment(previous, id));
    if (item?.previewUrl) {
      URL.revokeObjectURL(item.previewUrl);
    }
  };

  /** A sent message consumed the queue: release previews, empty the tray. */
  const clear = () => {
    for (const item of attachments) {
      if (item.previewUrl) {
        URL.revokeObjectURL(item.previewUrl);
      }
    }
    setAttachments([]);
  };

  // Screenshot paste (Sam 2026-09-02): a clipboard image uploads and lands
  // as an attachment exactly like the paperclip. Text pastes fall through
  // to the browser default.
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (editingActive) {
      return;
    }
    const images = imageFilesFromClipboard(event.clipboardData);
    if (images.length === 0) {
      return;
    }
    event.preventDefault();
    void attachFiles(images);
  };

  // Drag-and-drop onto the composer (2026-09-18): the tray and queue have
  // always been multi-file; this is the entry point the picker and paste
  // already had. The composer root is the drop surface, and the overlay
  // announces it. Text/URL drags are invisible here — `dragCarriesFiles`
  // reads the dragover-safe `types` list, so an overlay never flashes for
  // them and their default behaviour is untouched.
  const [dragDepth, setDragDepth] = useState(0);
  const [dragCount, setDragCount] = useState(0);
  const dropTargetActive = !editingActive && !busy;

  const onDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!dropTargetActive || !dragCarriesFiles(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    // enter/leave pair off per child element — count them (the classic
    // counter pattern) so crossing the textarea or a tray chip can't
    // thrash the overlay.
    setDragDepth((depth) => depth + 1);
    // Best-effort count for the overlay copy; not every engine fills
    // `items` during enter, in which case the copy omits the number.
    setDragCount(event.dataTransfer?.items?.length ?? 0);
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!dropTargetActive || !dragCarriesFiles(event.dataTransfer)) {
      return;
    }
    // preventDefault on EVERY dragover — without it the browser never fires
    // drop at all (the surface would read as "no files accepted here").
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const onDragLeave = () => {
    if (!dropTargetActive) {
      return;
    }
    setDragDepth((depth) => (depth > 0 ? depth - 1 : 0));
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!dropTargetActive || !dragCarriesFiles(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    setDragDepth(0);
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length === 0) {
      return; // a text/URL drag that slipped through — nothing to attach
    }
    const { accepted, rejections } = partitionDropFiles(files);
    // Same words, same surface as the picker's rejections (`attachFiles`).
    for (const { name, reason } of rejections) {
      toast.error(`${name}: ${reason}`);
    }
    if (accepted.length > 0) {
      void attachFiles(accepted);
    }
  };

  return {
    attachments,
    setAttachments,
    fileInputRef,
    attach,
    removeQueued,
    clear,
    onPaste,
    dropHandlers: { onDragEnter, onDragOver, onDragLeave, onDrop },
    dragDepth,
    dragCount,
    uploadsPending: hasPendingUploads(attachments),
    // An uploaded attachment alone is a sendable message — the markdown that
    // makes it non-empty is composed at send, so the button cannot key on the
    // visible text alone.
    hasUploaded: attachments.some((item) => item.descriptor != null),
  };
}
