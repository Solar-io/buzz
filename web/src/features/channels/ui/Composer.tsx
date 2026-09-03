import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import { toast } from "sonner";
import {
  AtSign,
  Bold,
  Code,
  Italic,
  Link as LinkIcon,
  List,
  Paperclip,
  Quote,
  Smile,
  Strikethrough,
} from "lucide-react";
import { cn } from "@/shared/lib/cn";
import { activeMentionQuery, resolveMentions } from "../lib/mentions.ts";
import {
  applyCode,
  applyLinePrefix,
  applyLink,
  applyWrap,
} from "../lib/composerFormat.ts";
import {
  activeEmojiQuery,
  applyEmojiCompletion,
  emojiSuggestions,
} from "../lib/emojiAutocomplete.ts";
import { imageFilesFromClipboard } from "../lib/composerPaste.ts";
import { loadDraft } from "../lib/drafts.ts";
import { buildImetaTag, mediaMarkdown } from "../lib/imeta.ts";
import { uploadBlob, type BlobDescriptor } from "@/shared/api/blossom";
import { EmojiPicker } from "@/shared/ui/EmojiPicker";
import type { ChannelMember, Profile } from "../hooks.ts";

export interface ThreadRef {
  rootId: string;
  replyToId: string;
}

export function Composer({
  members,
  profiles,
  threadRef,
  replyTargetLabel,
  onClearThread,
  onSent,
  onTextChange,
  editing,
  onCancelEdit,
  editSend,
  draftKey,
  placeholder,
  send,
}: {
  members: ChannelMember[];
  profiles: Map<string, Profile>;
  threadRef: ThreadRef | null;
  /**
   * Author of the message the NIP-10 `reply` marker names, when that is a
   * specific message rather than the thread root. The reply target is
   * otherwise invisible state — the author cannot tell what their reply will
   * be threaded under. Null means "the thread itself".
   */
  replyTargetLabel?: string | null;
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
  /** Overrides the idle textarea hint (forum views say "Write your post..."). */
  placeholder?: string;
  send: (options: {
    content: string;
    mentionPubkeys: string[];
    threadRef: ThreadRef | null;
    mediaTags: string[][];
  }) => Promise<{ ok: boolean; message: string }>;
}) {
  const [text, setText] = useState(() => (draftKey ? loadDraft(draftKey) : ""));
  const [busy, setBusy] = useState(false);
  const [popupIndex, setPopupIndex] = useState(0);
  // Re-render trigger for caret moves that happen outside React's knowledge
  // (the @ button sets the caret in rAF; suggestions read DOM selection).
  const [, bumpCaretRender] = useReducer((tick: number) => tick + 1, 0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [media, setMedia] = useState<BlobDescriptor[]>([]);
  const [uploading, setUploading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
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
  // Switching channels restores that channel's persisted draft.
  useEffect(() => {
    setText(draftKey ? loadDraft(draftKey) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]);
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
      setText(editing.original);
      textareaRef.current?.focus();
      return;
    }
    if (editingIdRef.current !== null) {
      editingIdRef.current = null;
      setText(draftKey ? loadDraft(draftKey) : "");
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

  const query = (() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return null;
    }
    const caret = textarea.selectionStart ?? text.length;
    // Non-null the moment an "@" token is open at the caret — including a
    // bare "@" (the regex's name group matches empty), which is what the
    // @ button leaves behind. TYPING @ therefore opens the list, not just
    // the button (Sam 2026-09-02: "if I do an @ and an agent's name,
    // nothing happens").
    return activeMentionQuery(text, caret);
  })();
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
    // `query` comes from an uncontrolled caret; recompute on text changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, namedMembers, mentionDismissed]);

  const applySuggestion = (name: string) => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    const caret = textarea.selectionStart ?? text.length;
    const upToCaret = text.slice(0, caret);
    const at = upToCaret.lastIndexOf("@");
    if (at === -1) {
      return;
    }
    const next = `${text.slice(0, at)}@${name} ${text.slice(caret)}`;
    setText(next);
    setMentionDismissed(true);
    requestAnimationFrame(() => {
      const position = at + name.length + 2;
      textarea.focus();
      textarea.setSelectionRange(position, position);
    });
  };

  /** Insert an emoji at the caret (or the end when the textarea is unfocused). */
  const insertEmoji = (emoji: string) => {
    const textarea = textareaRef.current;
    if (!textarea) {
      setText((previous) => `${previous}${emoji}`);
      return;
    }
    const start = textarea.selectionStart ?? text.length;
    const end = textarea.selectionEnd ?? start;
    const next = `${text.slice(0, start)}${emoji}${text.slice(end)}`;
    setText(next);
    onTextChange?.(next);
    requestAnimationFrame(() => {
      const caret = start + emoji.length;
      textarea.focus();
      textarea.setSelectionRange(caret, caret);
    });
  };

  // Rich-text toolbar: apply a format fn to the current selection and restore
  // the selection the fn computed (rAF so React's controlled value lands first).
  const applyFormat = (
    format: (
      text: string,
      start: number,
      end: number,
    ) => { text: string; selStart: number; selEnd: number },
  ) => {
    const textarea = textareaRef.current;
    if (!textarea || editingActive) {
      return;
    }
    const result = format(
      text,
      textarea.selectionStart ?? text.length,
      textarea.selectionEnd ?? text.length,
    );
    setText(result.text);
    onTextChange?.(result.text);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(result.selStart, result.selEnd);
    });
  };

  // :code: emoji autocomplete — rides the same popup machinery as mentions.
  const emojiToken = (() => {
    const textarea = textareaRef.current;
    if (!textarea || query !== null) {
      return null;
    }
    return activeEmojiQuery(text, textarea.selectionStart ?? text.length);
  })();
  const emojiMatches = useMemo(
    () => (emojiToken === null ? [] : emojiSuggestions(emojiToken)),
    [emojiToken],
  );
  const [emojiIndex, setEmojiIndex] = useState(0);
  const applyEmojiMatch = (match: { emoji: string }) => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    const result = applyEmojiCompletion(
      text,
      textarea.selectionStart ?? text.length,
      match.emoji,
    );
    setText(result.text);
    onTextChange?.(result.text);
    setEmojiIndex(0);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(result.caret, result.caret);
    });
  };

  const attach = async (files: FileList | null) => {
    if (!files || files.length === 0) {
      return;
    }
    await attachFiles(Array.from(files));
  };

  const attachFiles = async (files: File[]) => {
    if (files.length === 0) {
      return;
    }
    setUploading(true);
    try {
      for (const file of files) {
        const descriptor = await uploadBlob(file);
        setMedia((previous) => [...previous, descriptor]);
        setText((previous) => `${previous}${mediaMarkdown(descriptor)}`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Upload failed.");
    } finally {
      setUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
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

  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed || busy) {
      return;
    }
    const { mentionPubkeys, unresolved } = resolveMentions(
      trimmed,
      namedMembers,
    );
    setBusy(true);
    try {
      const result = editingActive
        ? ((await editSend?.(trimmed)) ?? { ok: false, message: "" })
        : await send({
            content: trimmed,
            mentionPubkeys,
            threadRef,
            mediaTags: media.map((descriptor) => buildImetaTag(descriptor)),
          });
      if (result.ok) {
        setText("");
        setMedia([]);
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
        applySuggestion(suggestions[popupIndex]?.name ?? "");
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
                onClick={() => applySuggestion(member.name)}
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
      {threadRef && !editingActive && (
        <p className="mb-1 text-xs text-muted-foreground">
          {replyTargetLabel ? (
            <>
              Replying to{" "}
              <span className="font-medium text-foreground">
                {replyTargetLabel}
              </span>{" "}
              — Esc clears
            </>
          ) : (
            "Replying in thread — Esc clears"
          )}
        </p>
      )}
      {editingActive && (
        <p className="mb-1 flex items-center gap-2 text-xs text-amber-300/90">
          Editing message
          <button
            type="button"
            className="underline underline-offset-2 hover:text-amber-200"
            onClick={() => onCancelEdit?.()}
          >
            cancel
          </button>
          <span className="text-muted-foreground">— Esc cancels</span>
        </p>
      )}
      {!editingActive && (
        <div
          className="mb-1.5 flex items-center gap-0.5"
          role="toolbar"
          aria-label="Format message"
        >
          {(
            [
              {
                label: "Bold",
                hint: "B",
                title: "Bold (⌘B)",
                apply: (t: string, s: number, e: number) =>
                  applyWrap(t, s, e, "**"),
                content: <Bold aria-hidden className="h-4 w-4" />,
              },
              {
                label: "Italic",
                hint: "I",
                title: "Italic (⌘I)",
                apply: (t: string, s: number, e: number) =>
                  applyWrap(t, s, e, "_"),
                content: <Italic aria-hidden className="h-4 w-4" />,
              },
              {
                label: "Strikethrough",
                hint: "S",
                title: "Strikethrough",
                apply: (t: string, s: number, e: number) =>
                  applyWrap(t, s, e, "~~"),
                content: <Strikethrough aria-hidden className="h-4 w-4" />,
              },
              {
                label: "Inline code",
                hint: "code",
                title: "Inline code",
                apply: applyCode,
                content: <Code aria-hidden className="h-4 w-4" />,
              },
              {
                label: "Link",
                hint: "link",
                title: "Link",
                apply: applyLink,
                content: <LinkIcon aria-hidden className="h-4 w-4" />,
              },
              {
                label: "Bulleted list",
                hint: "list",
                title: "Bulleted list",
                apply: (t: string, s: number, e: number) =>
                  applyLinePrefix(t, s, e, "- "),
                content: <List aria-hidden className="h-4 w-4" />,
              },
              {
                label: "Quote",
                hint: "quote",
                title: "Quote",
                apply: (t: string, s: number, e: number) =>
                  applyLinePrefix(t, s, e, "> "),
                content: <Quote aria-hidden className="h-4 w-4" />,
              },
            ] as const
          ).map((item) => (
            <button
              key={item.hint}
              type="button"
              aria-label={item.label}
              title={item.title}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
              disabled={busy}
              onClick={() => applyFormat(item.apply)}
            >
              {item.content}
            </button>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/gif,image/webp,video/mp4"
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
            className="max-h-60 min-h-11 flex-1 resize-none overflow-y-auto bg-transparent px-3 py-2 text-base placeholder:text-muted-foreground focus-visible:outline-hidden"
            placeholder={
              editingActive
                ? "Editing your message — Esc cancels"
                : (placeholder ??
                  "Message — @ to mention, Shift+Enter for newline")
            }
            rows={1}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              onTextChange?.(event.target.value);
              setPopupIndex(0);
            }}
            onKeyDown={onKeyDown}
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
              title="Attach images or video — or paste a screenshot"
              className="rounded-lg p-2 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
              disabled={uploading || busy}
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip
                aria-hidden
                className={cn("h-5 w-5", uploading && "animate-pulse")}
              />
            </button>
            <button
              type="button"
              aria-label="Mention someone"
              title="Mention — inserts @"
              className="rounded-lg p-2 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
              disabled={busy || editingActive}
              onClick={() => {
                const textarea = textareaRef.current;
                if (!textarea) {
                  return;
                }
                const start = textarea.selectionStart ?? text.length;
                const end = textarea.selectionEnd ?? start;
                const next = `${text.slice(0, start)}@${text.slice(end)}`;
                setText(next);
                setMentionDismissed(false);
                requestAnimationFrame(() => {
                  const caret = start + 1;
                  textarea.focus();
                  textarea.setSelectionRange(caret, caret);
                  bumpCaretRender();
                });
              }}
            >
              <AtSign aria-hidden className="h-5 w-5" />
            </button>
            <EmojiPicker label="Insert emoji" onSelect={insertEmoji}>
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
          disabled={busy || !text.trim()}
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
