import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import { toast } from "sonner";
import { AtSign, Paperclip, Smile } from "lucide-react";
import { cn } from "@/shared/lib/cn";
import { activeMentionQuery, resolveMentions } from "../lib/mentions.ts";
import { applyWrap } from "../lib/composerFormat.ts";
import {
  activeMarks,
  NO_ACTIVE_MARKS,
  type ActiveMarks,
} from "../lib/composerActiveMarks.ts";
import {
  activeEmojiQuery,
  applyEmojiCompletion,
  emojiSuggestions,
} from "../lib/emojiAutocomplete.ts";
import { imageFilesFromClipboard } from "../lib/composerPaste.ts";
import { loadDraftState, saveDraftState } from "../lib/drafts.ts";
import { buildImetaTag } from "../lib/imeta.ts";
import {
  attachmentMarkdown,
  removeAttachmentMarkdown,
} from "../lib/attachmentMarkdown.ts";
import {
  ATTACHMENT_ACCEPT,
  attachmentRejectionReason,
} from "../lib/attachmentAccept.ts";
import {
  filenamesByUrl,
  hasPendingUploads,
  markFailed,
  markUploaded,
  markUploading,
  queuedFrom,
  queueFromDescriptors,
  removeAttachment,
  uploadedDescriptors,
  withProgress,
  type QueuedAttachment,
} from "../lib/attachmentQueue.ts";
import {
  channelLabelFromSeed,
  composerPlaceholder,
} from "../lib/composerPlaceholder.ts";
import { uploadBlob } from "@/shared/api/blossom";
import { EmojiPicker } from "@/shared/ui/EmojiPicker";
import { useCustomEmoji } from "@/features/custom-emoji/hooks";
import { buildCustomEmojiTags } from "@/features/custom-emoji/lib/customEmojiTags";
import {
  ComposerFormatToolbar,
  type FormatFn,
} from "./ComposerFormatToolbar.tsx";
import {
  ComposerEditBanner,
  ComposerReplyBanner,
} from "./ComposerReplyBanner.tsx";
import { ComposerAttachmentTray } from "./ComposerAttachmentTray.tsx";
import type { ChannelMember, Profile } from "../hooks.ts";

export interface ThreadRef {
  rootId: string;
  replyToId: string;
}

/** The message a reply is aimed at, for the composer's quoted banner. */
export interface ComposerReplyTarget {
  author: string;
  /** Raw content — excerpted for display, never rendered as markdown. */
  body: string;
}

/** Selection offsets into the textarea's value. */
interface Selection {
  start: number;
  end: number;
}

export function Composer({
  members,
  profiles,
  threadRef,
  replyTarget,
  onClearThread,
  onSent,
  onTextChange,
  editing,
  onCancelEdit,
  editSend,
  draftKey,
  channelName,
  placeholder,
  send,
}: {
  members: ChannelMember[];
  profiles: Map<string, Profile>;
  threadRef: ThreadRef | null;
  /**
   * The message the NIP-10 `reply` marker names, when that is a specific
   * message rather than the thread root. The reply target is otherwise
   * invisible state — the author cannot tell what their reply will be threaded
   * under. Null means "the thread itself".
   */
  replyTarget?: ComposerReplyTarget | null;
  onClearThread: () => void;
  onSent?: () => void;
  /** Notified on every text change — the parent broadcasts typing frames. */
  onTextChange?: (text: string) => void;
  /** Message being edited — prefills the composer; submit routes to editSend. */
  editing?: { id: string; original: string } | null;
  onCancelEdit?: () => void;
  editSend?: (content: string) => Promise<{ ok: boolean; message: string }>;
  /** Channel id the draft belongs to — changing it restores that channel's draft. */
  draftKey?: string;
  /**
   * Channel display name for the placeholder. Optional: when the caller does
   * not have it (the channel route passes only the id), it is resolved from
   * the seeded channel list — see lib/composerPlaceholder.ts.
   */
  channelName?: string | null;
  /** Overrides the idle textarea hint (forum views say "Write your post..."). */
  placeholder?: string;
  send: (options: {
    content: string;
    mentionPubkeys: string[];
    threadRef: ThreadRef | null;
    mediaTags: string[][];
  }) => Promise<{ ok: boolean; message: string }>;
}) {
  const initialDraft = useRef(draftKey ? loadDraftState(draftKey) : null);
  const [text, setText] = useState(() => initialDraft.current?.text ?? "");
  const [busy, setBusy] = useState(false);
  const [popupIndex, setPopupIndex] = useState(0);
  // The caret/selection, mirrored into React state. The textarea is
  // uncontrolled for selection, but the toolbar's aria-pressed depends on
  // where the caret is, so every caret move has to reach a render.
  const [selection, setSelection] = useState<Selection>({ start: 0, end: 0 });
  const [mentionDismissed, setMentionDismissed] = useState(false);
  // Pubkeys captured when the author picks from the mention autocomplete.
  // Resolving by display name at send time cannot tell two members with the
  // same name apart; a pick can. Keyed by lowercased inserted name.
  const [mentionPicks, setMentionPicks] = useState<Map<string, string>>(
    () => new Map(Object.entries(initialDraft.current?.mentionPicks ?? {})),
  );
  const [attachments, setAttachments] = useState<QueuedAttachment[]>(() =>
    queueFromDescriptors(
      initialDraft.current?.media ?? [],
      initialDraft.current?.filenames ?? {},
    ),
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // The community's NIP-30 palette, for the emoji tags a send has to carry.
  const customEmoji = useCustomEmoji();
  // Current text without waiting for a re-render: the upload path appends
  // markdown from an async callback, and reading `text` there would capture
  // whatever the closure was created with.
  const textRef = useRef(text);
  const onTextChangeRef = useRef(onTextChange);
  onTextChangeRef.current = onTextChange;

  /** The single place text changes: keeps the ref, state and parent in step. */
  const applyText = useCallback((next: string) => {
    textRef.current = next;
    setText(next);
    onTextChangeRef.current?.(next);
  }, []);

  /** Set text without notifying the parent (draft restore, edit prefill). */
  const restoreText = useCallback((next: string) => {
    textRef.current = next;
    setText(next);
  }, []);

  /** Read the live caret back out of the DOM after any programmatic move. */
  const syncSelection = useCallback(() => {
    const el = textareaRef.current;
    if (!el) {
      return;
    }
    setSelection((previous) => {
      const start = el.selectionStart ?? 0;
      const end = el.selectionEnd ?? start;
      return previous.start === start && previous.end === end
        ? previous
        : { start, end };
    });
  }, []);

  /** Focus the textarea, place the caret, and refresh the mark state. */
  const focusAt = useCallback((start: number, end: number = start) => {
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) {
        return;
      }
      el.focus();
      el.setSelectionRange(start, end);
      setSelection({ start, end });
    });
  }, []);

  // Auto-grow (Sam 2026-09-02: "the text entry area should expand as the
  // user types"): fit the textarea's height to its content on every text
  // change — typing, draft restore, edit prefill, paste — capped at
  // MAX_TEXTAREA_PX, beyond which it scrolls internally. Keyed on `text`
  // so every path that sets state re-measures.
  // biome-ignore lint/correctness/useExhaustiveDependencies: text is the re-measure trigger by design, not a read inside the effect
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) {
      return;
    }
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  // Switching channels restores that channel's persisted draft — text,
  // uploaded attachments and mention picks together (see lib/drafts.ts).
  const firstDraftLoad = useRef(true);
  // Set while a channel switch is mid-flight: the restore effect below has
  // loaded the NEW channel's draft but the attachment/pick state still belongs
  // to the OLD one until React re-renders. Without this, the persist effect —
  // which runs in the same commit because draftKey is one of its deps — would
  // briefly write the old channel's attachments under the new channel's key.
  const restoringDraft = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: draftKey is the restore trigger; the setters are stable
  useEffect(() => {
    if (firstDraftLoad.current) {
      // useState initialisers already loaded this draft; re-running here
      // would clobber a keystroke typed before the effect first fires.
      firstDraftLoad.current = false;
      return;
    }
    restoringDraft.current = true;
    const draft = draftKey ? loadDraftState(draftKey) : null;
    restoreText(draft?.text ?? "");
    setMentionPicks(new Map(Object.entries(draft?.mentionPicks ?? {})));
    setAttachments(
      queueFromDescriptors(draft?.media ?? [], draft?.filenames ?? {}),
    );
  }, [draftKey]);

  // Persist attachments and mention picks. Text is written by the parent's
  // onTextChange (saveDraft merges rather than replaces, so it cannot drop
  // what this writes); this effect runs after render, so textRef is current.
  useEffect(() => {
    if (!draftKey) {
      return;
    }
    if (restoringDraft.current) {
      // Skip exactly one run — the restore's setters always change state
      // identity, so the next commit re-runs this with the new channel's data.
      restoringDraft.current = false;
      return;
    }
    saveDraftState(draftKey, {
      text: textRef.current,
      media: uploadedDescriptors(attachments),
      filenames: filenamesByUrl(attachments),
      mentionPicks: Object.fromEntries(mentionPicks),
    });
  }, [draftKey, attachments, mentionPicks]);

  // Entering edit mode prefills the composer with the original text. Leaving
  // it restores the channel draft — after a successful edit the route has
  // already cleared the stored draft, so this is ""; after cancel it is the
  // user's pre-edit draft.
  const editingIdRef = useRef<string | null>(null);
  // draftKey changes are handled by the switch effect above.
  // biome-ignore lint/correctness/useExhaustiveDependencies: draftKey covered by the draftKey effect
  useEffect(() => {
    if (editing) {
      editingIdRef.current = editing.id;
      restoreText(editing.original);
      textareaRef.current?.focus();
      return;
    }
    if (editingIdRef.current !== null) {
      editingIdRef.current = null;
      restoreText(draftKey ? loadDraftState(draftKey).text : "");
    }
  }, [editing]);
  const editingActive = editing != null;

  const namedMembers = useMemo(
    () =>
      members.map((member) => ({
        pubkey: member.pubkey,
        name:
          profiles
            .get(member.pubkey)
            ?.displayName.replace(/\s+/g, " ")
            .trim() || member.name,
      })),
    [members, profiles],
  );

  // Non-null the moment an "@" token is open at the caret — including a
  // bare "@" (the regex's name group matches empty), which is what the
  // @ button leaves behind. TYPING @ therefore opens the list, not just
  // the button (Sam 2026-09-02: "if I do an @ and an agent's name,
  // nothing happens").
  const query = activeMentionQuery(
    text,
    Math.min(selection.start, text.length),
  );
  // A fresh token re-arms the popup after an Escape dismissal.
  useEffect(() => {
    setMentionDismissed(false);
  }, [query]);
  const suggestions = useMemo(() => {
    if (query === null || mentionDismissed) {
      return [];
    }
    const lower = query.toLowerCase();
    return namedMembers
      .filter((member) => member.name.toLowerCase().includes(lower))
      .slice(0, 6);
  }, [query, namedMembers, mentionDismissed]);

  // Which toolbar buttons render as pressed. Reading marks off the markdown
  // around the selection is the textarea equivalent of the desktop's
  // `editor.isActive(...)`; see lib/composerActiveMarks.ts for what it
  // deliberately refuses to guess at.
  const marks: ActiveMarks = useMemo(() => {
    if (editingActive) {
      return NO_ACTIVE_MARKS;
    }
    const start = Math.min(selection.start, text.length);
    const end = Math.min(selection.end, text.length);
    return activeMarks(text, start, end);
  }, [text, selection, editingActive]);

  const applySuggestion = (name: string, pubkey?: string) => {
    if (pubkey) {
      setMentionPicks((previous) => {
        const next = new Map(previous);
        next.set(name.toLowerCase(), pubkey);
        return next;
      });
    }
    const caret = Math.min(selection.start, text.length);
    const upToCaret = text.slice(0, caret);
    const at = upToCaret.lastIndexOf("@");
    if (at === -1) {
      return;
    }
    applyText(`${text.slice(0, at)}@${name} ${text.slice(caret)}`);
    setMentionDismissed(true);
    focusAt(at + name.length + 2);
  };

  /** Insert an emoji at the caret (or the end when the textarea is unfocused). */
  const insertEmoji = (emoji: string) => {
    const start = Math.min(selection.start, text.length);
    const end = Math.min(selection.end, text.length);
    applyText(`${text.slice(0, start)}${emoji}${text.slice(end)}`);
    focusAt(start + emoji.length);
  };

  /**
   * Insert a chosen GIF's markdown on its own line at the end.
   *
   * Not at the caret, unlike an emoji: a GIF is a block image, and dropping
   * `![…](…)` mid-sentence would split the paragraph the author was typing.
   * This matches how an uploaded attachment appends (see `attachFiles`).
   */
  const insertGif = (markdown: string) => {
    const current = textRef.current;
    const separator = current === "" || current.endsWith("\n") ? "" : "\n";
    const next = `${current}${separator}${markdown}\n`;
    applyText(next);
    focusAt(next.length);
  };

  // Rich-text toolbar: apply a format fn to the current selection and restore
  // the selection the fn computed.
  const applyFormat = (format: FormatFn) => {
    if (editingActive) {
      return;
    }
    const start = Math.min(selection.start, text.length);
    const end = Math.min(selection.end, text.length);
    const result = format(text, start, end);
    applyText(result.text);
    focusAt(result.selStart, result.selEnd);
  };

  // :code: emoji autocomplete — rides the same popup machinery as mentions.
  const emojiToken =
    query !== null
      ? null
      : activeEmojiQuery(text, Math.min(selection.start, text.length));
  const emojiMatches = useMemo(
    () => (emojiToken === null ? [] : emojiSuggestions(emojiToken)),
    [emojiToken],
  );
  const [emojiIndex, setEmojiIndex] = useState(0);
  const applyEmojiMatch = (match: { emoji: string }) => {
    const result = applyEmojiCompletion(
      text,
      Math.min(selection.start, text.length),
      match.emoji,
    );
    applyText(result.text);
    setEmojiIndex(0);
    focusAt(result.caret);
  };

  const attach = async (files: FileList | null) => {
    if (!files || files.length === 0) {
      return;
    }
    await attachFiles(Array.from(files));
  };

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
        applyText(
          `${textRef.current}${attachmentMarkdown(descriptor, file.name)}`,
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Upload failed.";
        setAttachments((previous) => markFailed(previous, row.id, message));
        toast.error(`${file.name}: ${message}`);
      }
    }
  };

  /** Drop one attachment, its preview, and the markdown that referenced it. */
  const removeQueued = (id: string) => {
    const item = attachments.find((entry) => entry.id === id);
    setAttachments((previous) => removeAttachment(previous, id));
    if (!item) {
      return;
    }
    if (item.previewUrl) {
      URL.revokeObjectURL(item.previewUrl);
    }
    if (item.descriptor) {
      applyText(removeAttachmentMarkdown(textRef.current, item.descriptor.url));
    }
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

  const uploadsPending = hasPendingUploads(attachments);

  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed || busy || uploadsPending) {
      return;
    }
    const { mentionPubkeys, unresolved } = resolveMentions(
      trimmed,
      namedMembers,
      mentionPicks,
    );
    setBusy(true);
    try {
      const result = editingActive
        ? ((await editSend?.(trimmed)) ?? { ok: false, message: "" })
        : await send({
            content: trimmed,
            mentionPubkeys,
            threadRef,
            // `mediaTags` is appended verbatim to the event's tags by
            // `sendChannelMessage`, so it is also where the NIP-30 `emoji`
            // tags go. They are derived from the FINAL content, the same way
            // @mentions become `p` tags: without them the event carries a
            // bare `:shortcode:` and no other client can resolve the image.
            // (The field would be better named `extraTags` — that rename
            // touches files this change does not own.)
            mediaTags: [
              ...uploadedDescriptors(attachments).map((descriptor) =>
                buildImetaTag(descriptor),
              ),
              ...buildCustomEmojiTags(trimmed, customEmoji),
            ],
          });
      if (result.ok) {
        for (const item of attachments) {
          if (item.previewUrl) {
            URL.revokeObjectURL(item.previewUrl);
          }
        }
        applyText("");
        setAttachments([]);
        setMentionPicks(new Map());
        if (editingActive) {
          onCancelEdit?.();
        }
        onSent?.();
      } else {
        toast.error(result.message || "The relay rejected the message.");
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not send the message.",
      );
    } finally {
      setBusy(false);
      if (unresolved.length > 0) {
        toast.message(
          `Sent without p-tags for: ${unresolved.join(", ")} (no unique member match)`,
        );
      }
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setPopupIndex((index) => (index + 1) % suggestions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setPopupIndex(
          (index) => (index - 1 + suggestions.length) % suggestions.length,
        );
        return;
      }
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
        event.preventDefault();
        applySuggestion(
          suggestions[popupIndex]?.name ?? "",
          suggestions[popupIndex]?.pubkey,
        );
        return;
      }
      if (event.key === "Escape") {
        setPopupIndex(0);
        // Dismiss until the token changes (a fresh query re-arms it).
        setMentionDismissed(true);
        return;
      }
    }
    if (emojiMatches.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setEmojiIndex((index) => (index + 1) % emojiMatches.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setEmojiIndex(
          (index) => (index - 1 + emojiMatches.length) % emojiMatches.length,
        );
        return;
      }
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
        event.preventDefault();
        applyEmojiMatch(emojiMatches[emojiIndex] ?? emojiMatches[0]);
        return;
      }
      if (event.key === "Escape") {
        setEmojiIndex(0);
        return;
      }
    }
    // Rich-text shortcuts: ⌘B bold, ⌘I italic (no browser conflict inside a
    // textarea except ⌘I in some browsers — preventDefault covers it).
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") {
      event.preventDefault();
      applyFormat((t, s, e) => applyWrap(t, s, e, "**"));
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "i") {
      event.preventDefault();
      applyFormat((t, s, e) => applyWrap(t, s, e, "_"));
      return;
    }
    if (event.key === "Escape" && editingActive) {
      onCancelEdit?.();
      return;
    }
    if (event.key === "Escape" && threadRef) {
      onClearThread();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };

  const channelLabel = useMemo(
    () =>
      channelName
        ? { name: channelName, isDm: false }
        : channelLabelFromSeed(draftKey),
    [channelName, draftKey],
  );
  const computedPlaceholder = composerPlaceholder({
    override: placeholder,
    editing: editingActive,
    channel: channelLabel,
    replyToAuthor: replyTarget?.author ?? null,
  });

  return (
    <div className="relative border-t border-border p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-4">
      {suggestions.length > 0 && (
        <ul className="absolute bottom-full left-3 mb-1 w-64 overflow-hidden rounded-md border border-border bg-popover shadow-lg">
          {suggestions.map((member, index) => (
            <li key={member.pubkey}>
              <button
                type="button"
                className={cn(
                  "block w-full truncate px-3 py-1.5 text-left text-sm hover:bg-accent",
                  index === popupIndex && "bg-accent",
                )}
                onClick={() => applySuggestion(member.name, member.pubkey)}
              >
                @{member.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      {emojiMatches.length > 0 && (
        <ul className="absolute bottom-full left-3 mb-1 w-64 overflow-hidden rounded-md border border-border bg-popover shadow-lg">
          {emojiMatches.map((match, index) => (
            <li key={match.code}>
              <button
                type="button"
                className={cn(
                  "block w-full truncate px-3 py-1.5 text-left text-sm hover:bg-accent",
                  index === emojiIndex && "bg-accent",
                )}
                onClick={() => applyEmojiMatch(match)}
              >
                {match.emoji} {match.code}
              </button>
            </li>
          ))}
        </ul>
      )}
      {editingActive ? (
        <ComposerEditBanner onCancel={() => onCancelEdit?.()} />
      ) : threadRef && replyTarget ? (
        <ComposerReplyBanner
          author={replyTarget.author}
          body={replyTarget.body}
          onDismiss={onClearThread}
        />
      ) : threadRef ? (
        <p className="mb-1 text-xs text-muted-foreground">
          Replying in thread — Esc clears
        </p>
      ) : null}
      {!editingActive && (
        <ComposerFormatToolbar
          marks={marks}
          disabled={busy}
          onApply={applyFormat}
          onCaptureSelection={syncSelection}
        />
      )}
      {!editingActive && (
        <ComposerAttachmentTray
          attachments={attachments}
          onRemove={removeQueued}
        />
      )}
      <div className="flex items-end gap-2">
        <input
          ref={fileInputRef}
          type="file"
          accept={ATTACHMENT_ACCEPT}
          multiple
          className="hidden"
          onChange={(event) => void attach(event.target.files)}
        />
        {/* Desktop's composer shape: ONE rounded field carrying the icons
            inside it (attach / mention / emoji at the right edge), send
            circle just outside. No emoji glyphs — proper lucide icons. */}
        <div
          className={cn(
            "flex min-h-14 flex-1 items-end gap-1 rounded-2xl border border-input bg-card py-1.5 pl-1 pr-1.5 shadow-xs transition-colors",
            "focus-within:border-ring/60 focus-within:ring-1 focus-within:ring-ring",
          )}
        >
          <textarea
            ref={textareaRef}
            data-testid="composer-input"
            className="max-h-60 min-h-11 flex-1 resize-none overflow-y-auto bg-transparent px-3 py-2 text-base placeholder:text-muted-foreground focus-visible:outline-hidden"
            placeholder={computedPlaceholder}
            rows={1}
            value={text}
            onChange={(event) => {
              applyText(event.target.value);
              setPopupIndex(0);
              syncSelection();
            }}
            onKeyDown={onKeyDown}
            onKeyUp={syncSelection}
            onClick={syncSelection}
            onSelect={syncSelection}
            onFocus={syncSelection}
            onPaste={onPaste}
            onBlur={() => setPopupIndex(0)}
          />
          <div
            className="flex items-center gap-0.5 pb-0.5"
            role="toolbar"
            aria-label="Insert"
          >
            <button
              type="button"
              aria-label="Attach a file"
              title="Attach images, video or files — or paste a screenshot"
              className="rounded-lg p-2 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
              disabled={busy}
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip aria-hidden className="h-5 w-5" />
            </button>
            <button
              type="button"
              aria-label="Mention someone"
              title="Mention — inserts @"
              className="rounded-lg p-2 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
              disabled={busy || editingActive}
              onClick={() => {
                const start = Math.min(selection.start, text.length);
                const end = Math.min(selection.end, text.length);
                applyText(`${text.slice(0, start)}@${text.slice(end)}`);
                setMentionDismissed(false);
                focusAt(start + 1);
              }}
            >
              <AtSign aria-hidden className="h-5 w-5" />
            </button>
            <EmojiPicker
              label="Insert emoji"
              onSelect={insertEmoji}
              onSelectGif={insertGif}
            >
              {(props) => (
                <button
                  type="button"
                  ref={props.ref}
                  aria-label={props["aria-label"]}
                  title="Insert emoji"
                  className="rounded-lg p-2 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                  disabled={busy || editingActive}
                  onClick={props.onClick}
                >
                  <Smile aria-hidden className="h-5 w-5" />
                </button>
              )}
            </EmojiPicker>
          </div>
        </div>
        {/* Desktop's send control: filled primary circle with an up arrow. */}
        <button
          type="button"
          aria-label={editingActive ? "Save" : "Send"}
          title={uploadsPending ? "Waiting for uploads to finish" : undefined}
          disabled={busy || uploadsPending || !text.trim()}
          className="mb-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
          onClick={() => void submit()}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-5 w-5"
          >
            <path d="m5 12 7-7 7 7" />
            <path d="M12 19V5" />
          </svg>
        </button>
      </div>
    </div>
  );
}
