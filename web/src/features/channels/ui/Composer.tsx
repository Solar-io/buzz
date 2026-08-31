import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/shared/ui/button";
import { cn } from "@/shared/lib/cn";
import { activeMentionQuery, resolveMentions } from "../lib/mentions.ts";
import { buildImetaTag, mediaMarkdown } from "../lib/imeta.ts";
import { uploadBlob, type BlobDescriptor } from "@/shared/api/blossom";
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
  send,
}: {
  members: ChannelMember[];
  profiles: Map<string, Profile>;
  threadRef: ThreadRef | null;
  onClearThread: () => void;
  onSent?: () => void;
  /** Notified on every text change — the parent broadcasts typing frames. */
  onTextChange?: (text: string) => void;
  send: (options: {
    content: string;
    mentionPubkeys: string[];
    threadRef: ThreadRef | null;
    mediaTags: string[][];
  }) => Promise<{ ok: boolean; message: string }>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [popupIndex, setPopupIndex] = useState(0);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [media, setMedia] = useState<BlobDescriptor[]>([]);
  const [uploading, setUploading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
      const result = await send({
        content: trimmed,
        mentionPubkeys,
        threadRef,
        mediaTags: media.map((descriptor) => buildImetaTag(descriptor)),
      });
      if (result.ok) {
        setText("");
        setMedia([]);
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
      {threadRef && (
        <p className="mb-1 text-xs text-muted-foreground">
          Replying in thread — Esc clears
        </p>
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
        <textarea
          ref={textareaRef}
          className="max-h-56 min-h-14 flex-1 resize-y rounded-xl border border-input bg-card px-4 py-3 text-base shadow-xs placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
          placeholder="Message — @ to mention, Shift+Enter for newline"
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
          Send
        </Button>
      </div>
    </div>
  );
}
