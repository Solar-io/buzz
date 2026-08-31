import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { toast } from "sonner";
import { Button } from "@/shared/ui/button";
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
  onClearThread,
  onSent,
  onTextChange,
  editing,
  onCancelEdit,
  editSend,
  draftKey,
  send,
}: {
  members: ChannelMember[];
  profiles: Map<string, Profile>;
  threadRef: ThreadRef | null;
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
  const [mentionOpen, setMentionOpen] = useState(false);
  const [media, setMedia] = useState<BlobDescriptor[]>([]);
  const [uploading, setUploading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
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
    return activeMentionQuery(text, textarea.selectionStart ?? text.length);
  })();
  const suggestions = useMemo(() => {
    if (query === null || !mentionOpen) {
      return [];
    }
    const lower = query.toLowerCase();
    return namedMembers
      .filter((member) => member.name.toLowerCase().includes(lower))
      .slice(0, 6);
    // `query` comes from an uncontrolled caret; recompute on text changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, namedMembers, mentionOpen]);

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
    setMentionOpen(false);
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
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
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
          Replying in thread — Esc clears
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
                content: <span className="font-bold">B</span>,
              },
              {
                label: "Italic",
                hint: "I",
                title: "Italic (⌘I)",
                apply: (t: string, s: number, e: number) =>
                  applyWrap(t, s, e, "_"),
                content: <span className="italic">I</span>,
              },
              {
                label: "Strikethrough",
                hint: "S",
                title: "Strikethrough",
                apply: (t: string, s: number, e: number) =>
                  applyWrap(t, s, e, "~~"),
                content: <span className="line-through">S</span>,
              },
              {
                label: "Inline code",
                hint: "code",
                title: "Inline code",
                apply: applyCode,
                content: <span className="font-mono text-xs">{"<>"}</span>,
              },
              {
                label: "Link",
                hint: "link",
                title: "Link",
                apply: applyLink,
                content: "🔗",
              },
              {
                label: "Bulleted list",
                hint: "list",
                title: "Bulleted list",
                apply: (t: string, s: number, e: number) =>
                  applyLinePrefix(t, s, e, "- "),
                content: "•—",
              },
              {
                label: "Quote",
                hint: "quote",
                title: "Quote",
                apply: (t: string, s: number, e: number) =>
                  applyLinePrefix(t, s, e, "> "),
                content: "❝",
              },
            ] as const
          ).map((item) => (
            <button
              key={item.hint}
              type="button"
              aria-label={item.label}
              title={item.title}
              className="rounded p-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
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
        <button
          type="button"
          aria-label="Attach a file"
          title="Attach images or video"
          className="mb-0.5 rounded-lg p-2.5 text-muted-foreground hover:bg-accent disabled:opacity-50"
          disabled={uploading || busy}
          onClick={() => fileInputRef.current?.click()}
        >
          {uploading ? "…" : "📎"}
        </button>
        <EmojiPicker label="Insert emoji" onSelect={insertEmoji}>
          {(props) => (
            <button
              type="button"
              ref={props.ref}
              aria-label={props["aria-label"]}
              title="Insert emoji"
              className="mb-0.5 rounded-lg p-2.5 text-lg leading-none text-muted-foreground hover:bg-accent disabled:opacity-50"
              disabled={busy || editingActive}
              onClick={props.onClick}
            >
              🙂
            </button>
          )}
        </EmojiPicker>
        <textarea
          ref={textareaRef}
          className="max-h-56 min-h-14 flex-1 resize-y rounded-xl border border-input bg-card px-4 py-3 text-base shadow-xs placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
          placeholder={
            editingActive
              ? "Editing your message — Esc cancels"
              : "Message — @ to mention, Shift+Enter for newline"
          }
          rows={1}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            onTextChange?.(event.target.value);
            setPopupIndex(0);
            setMentionOpen(
              activeMentionQuery(
                event.target.value,
                event.target.selectionStart ?? event.target.value.length,
              ) !== null,
            );
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setPopupIndex(0)}
        />
        <Button
          size="sm"
          disabled={busy || !text.trim()}
          onClick={() => void submit()}
        >
          {editingActive ? "Save" : "Send"}
        </Button>
      </div>
    </div>
  );
}
