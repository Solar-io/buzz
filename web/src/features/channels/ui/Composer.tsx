import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import { notify, toast } from "@/shared/ui/notify";
import { cn } from "@/shared/lib/cn";
import { useOwnPubkey } from "@/shared/lib/useOwnPubkey";
import {
  type ComposerCommands,
  useComposerCommands,
} from "@/features/commands/useComposerCommands.ts";
import { resolveMentions } from "../lib/mentions.ts";
import { applyWrap } from "../lib/composerFormat.ts";
import {
  activeMarks,
  NO_ACTIVE_MARKS,
  type ActiveMarks,
} from "../lib/composerActiveMarks.ts";
import { loadDraftState, saveDraftState } from "../lib/drafts.ts";
import { buildImetaTag } from "../lib/imeta.ts";
import { returnInsertsNewline } from "../lib/returnKey.ts";
import {
  composeSendContent,
  stripAttachmentsMarkdown,
} from "../lib/attachmentMarkdown.ts";
import { ATTACHMENT_ACCEPT } from "../lib/attachmentAccept.ts";
import {
  filenamesByUrl,
  queueFromDescriptors,
  uploadedDescriptors,
} from "../lib/attachmentQueue.ts";
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
import { ComposerFrame } from "./ComposerFrame.tsx";
import { ComposerLinkPreviewTray } from "./ComposerLinkPreviewTray.tsx";
import { ComposerSuggestionLists } from "./ComposerSuggestionLists.tsx";
import { useComposerLinkPreviews } from "../lib/useComposerLinkPreviews.ts";
import type { ChannelMember, Profile } from "../hooks.ts";
import { useComposerAttachments } from "./useComposerAttachments.ts";
import {
  useComposerSuggestions,
  type ComposerSelection,
} from "./useComposerSuggestions.ts";

export interface ThreadRef {
  rootId: string;
  replyToId: string;
}

/**
 * The imperative surface the composer exposes to its owner (React 19's
 * ref-as-prop). It exists for dictation — the mic button lives on the actions
 * row the ROUTE renders, while the draft text is composer-local state — and
 * for ⌘K, which hands a command that needs arguments to the box to finish.
 * A named handle rather than callback props, so the route wires it once with
 * a ref and never re-renders the composer on its account.
 */
export interface ComposerHandle {
  /** Append finalized dictation text at the end of the draft. */
  appendDictation: (chunk: string) => void;
  /** Replace the draft and put the caret at its end (⌘K → "/handoff "). */
  prefill: (text: string) => void;
  /** Put the caret at the end of the draft (a toast's Reply in a DM). */
  focus: () => void;
}

/** The message a reply is aimed at, for the composer's quoted banner. */
export interface ComposerReplyTarget {
  author: string;
  /** Raw content — excerpted for display, never rendered as markdown. */
  body: string;
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
  placeholder,
  actionsBar,
  strictMentions = false,
  autoNotify = null,
  variant = "default",
  commands,
  commandContext,
  autoFocus = false,
  status,
  send,
  ref,
}: {
  members: ChannelMember[];
  profiles: Map<string, Profile>;
  /**
   * When set, every send is threaded under that root (an inline thread's
   * reply box). Absent/null — the channel's main composer, which posts
   * top-level even while a thread is open under a message: only the thread's
   * own box may target the thread (Sam 2026-09-20).
   */
  threadRef?: ThreadRef | null;
  /**
   * The message the NIP-10 `reply` marker names, when that is a specific
   * message rather than the thread root. The reply target is otherwise
   * invisible state — the author cannot tell what their reply will be threaded
   * under. Null means "the thread itself".
   */
  replyTarget?: ComposerReplyTarget | null;
  /**
   * Esc with a thread aimed: the caller drops the mid-thread target, or
   * collapses the thread when the box already answers the root. Without a
   * threadRef there is nothing to clear and Esc does nothing.
   */
  onClearThread?: () => void;
  onSent?: () => void;
  /** Notified on every text change — the parent broadcasts typing frames. */
  onTextChange?: (text: string) => void;
  /** Message being edited — prefills the composer; submit routes to editSend. */
  editing?: { id: string; original: string } | null;
  onCancelEdit?: () => void;
  editSend?: (content: string) => Promise<{ ok: boolean; message: string }>;
  /** Channel id the draft belongs to — changing it restores that channel's draft. */
  draftKey?: string;
  /** The field's hint: "Message #flight-path", "Reply in thread…". */
  placeholder?: string;
  /**
   * Channel controls on the tool row's right end (the dictation mic, the
   * one-click DM call, the thinking toggle). Only the main channel composer
   * passes this. Hidden while an edit is in progress.
   */
  actionsBar?: ReactNode;
  strictMentions?: boolean;
  /**
   * A participant every send from this composer should wake WITHOUT the
   * author typing an @. Set for a thread whose only other voice is one person
   * or agent — Sam 2026-09-20: "if two people are the only ones in the
   * conversation, then I shouldn't have to tag them." `label` is the display
   * name the "… will be notified" hint shows. Null/absent means no automatic
   * tagging: the main-channel composer's payload is untouched. The tag is
   * not announced under the box any more — Sam (2026-09-30) cut the
   * "… will be notified" line as noise; `label` names it for assistive tech.
   */
  autoNotify?: { pubkey: string; label: string } | null;
  /**
   * "inline" is the thread reply box under a message: one slim field, no tool
   * row. "default" is the channel composer (Main artboard), which is also the
   * compact `/` · field · send row below md (PhoneChannel artboard).
   */
  variant?: "default" | "inline";
  /**
   * Slash commands (web redesign Phase 2). A host object runs them here;
   * "elsewhere" refuses a slash line instead of posting it; undefined leaves
   * the text alone. A command is NEVER passed to `send`.
   */
  commands?: ComposerCommands;
  /** "in #flight-path" — the command list's title row. */
  commandContext?: string;
  /** Take focus on mount (a thread opened to reply). */
  autoFocus?: boolean;
  /**
   * Directly above the box: the conversation's status line — who is working
   * or typing here (RunningStrip). It sits where the eye is while waiting for
   * an answer, above any reply banner or attachment tray (Sam, 2026-09-30).
   */
  status?: ReactNode;
  send: (options: {
    content: string;
    mentionPubkeys: string[];
    threadRef: ThreadRef | null;
    mediaTags: string[][];
  }) => Promise<{ ok: boolean; message: string }>;
  /** React 19 ref-as-prop; see {@link ComposerHandle}. */
  ref?: Ref<ComposerHandle>;
}) {
  const initialDraft = useRef(draftKey ? loadDraftState(draftKey) : null);
  // Drafts saved before attachments stopped showing their markdown in the
  // box (2026-09-17) carry it in `text` — strip it on load so the tray chip
  // is the attachment's only visible presence.
  const [text, setText] = useState(() =>
    stripAttachmentsMarkdown(
      initialDraft.current?.text ?? "",
      initialDraft.current?.media ?? [],
    ),
  );
  const [busy, setBusy] = useState(false);
  // The caret/selection, mirrored into React state. The textarea is
  // uncontrolled for selection, but the toolbar's aria-pressed depends on
  // where the caret is, so every caret move has to reach a render.
  const [selection, setSelection] = useState<ComposerSelection>({
    start: 0,
    end: 0,
  });
  // Pubkeys captured when the author picks from the mention autocomplete.
  // Resolving by display name at send time cannot tell two members with the
  // same name apart; a pick can. Keyed by lowercased inserted name.
  const [mentionPicks, setMentionPicks] = useState<Map<string, string>>(
    () => new Map(Object.entries(initialDraft.current?.mentionPicks ?? {})),
  );
  const editingActive = editing != null;
  const queue = useComposerAttachments({
    initial: () =>
      queueFromDescriptors(
        initialDraft.current?.media ?? [],
        initialDraft.current?.filenames ?? {},
      ),
    editingActive,
    busy,
  });
  const { attachments, setAttachments } = queue;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // The community's NIP-30 palette, for the emoji tags a send has to carry.
  const customEmoji = useCustomEmoji();
  // The author's own key — @everyone expands to everyone EXCEPT them.
  const selfPubkey = useOwnPubkey();
  // Current text without waiting for a re-render: async paths (draft
  // persistence, GIF inserts) read text between renders, and reading `text`
  // there would capture whatever the closure was created with.
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

  /**
   * Where the caret goes once the text it belongs to is on the page.
   *
   * Applied in a layout effect — after React has written the new value and
   * before the browser handles the next key — so a key typed straight after
   * a pick (Enter on "@Lord Nikon", then "r") lands after the name. Placing
   * it on the next animation frame alone was a frame late: the "r" went in
   * at the old caret, then the frame moved the caret back in front of it
   * (Phase 2 QA). The frame stays as the fallback for a move that causes no
   * render (focusing an unchanged draft), and is a no-op once applied.
   */
  const pendingCaret = useRef<{ start: number; end: number } | null>(null);
  const applyPendingCaret = useCallback(() => {
    const next = pendingCaret.current;
    const el = textareaRef.current;
    if (!next || !el) {
      return;
    }
    pendingCaret.current = null;
    el.focus();
    el.setSelectionRange(next.start, next.end);
    setSelection((previous) =>
      previous.start === next.start && previous.end === next.end
        ? previous
        : next,
    );
  }, []);
  useLayoutEffect(() => {
    applyPendingCaret();
  });

  /** Focus the textarea, place the caret, and refresh the mark state. */
  const focusAt = useCallback(
    (start: number, end: number = start) => {
      pendingCaret.current = { start, end };
      requestAnimationFrame(applyPendingCaret);
    },
    [applyPendingCaret],
  );

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

  // A thread opened to reply takes the caret (↩, "Answer in chat instead").
  useEffect(() => {
    if (autoFocus) {
      textareaRef.current?.focus();
    }
  }, [autoFocus]);

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
    // Same old-draft migration as the initial state: strip markdown that
    // belongs to the draft's own attachments (the tray shows them).
    restoreText(
      stripAttachmentsMarkdown(draft?.text ?? "", draft?.media ?? []),
    );
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
      // Third and last draft-restore path (initial load, channel switch,
      // edit exit) — same old-draft migration as the other two.
      const draft = draftKey ? loadDraftState(draftKey) : null;
      restoreText(
        stripAttachmentsMarkdown(draft?.text ?? "", draft?.media ?? []),
      );
    }
  }, [editing]);

  // Slash commands: what the list offers for the token being typed, and the
  // intercept `submit` consults before it sends anything. The send ref lets a
  // command publish through THIS composer's send path (`/handoff`).
  const sendRef = useRef(send);
  sendRef.current = send;
  const namedMembersRef = useRef<{ pubkey: string; name: string }[]>([]);
  const commandRun = useComposerCommands({
    host: editingActive ? undefined : commands,
    text,
    caret: Math.min(selection.start, text.length),
    selfPubkey,
    members: namedMembersRef.current,
    mentionPicks,
    send: (options) => sendRef.current(options),
    onRan: (notice) => {
      applyText("");
      setMentionPicks(new Map());
      if (notice) {
        toast.success(notice);
      }
    },
  });

  // /command, @mention and :emoji: autocomplete (useComposerSuggestions). The
  // picks map stays here: draft persistence and submit both read it.
  const suggest = useComposerSuggestions({
    text,
    selection,
    members,
    profiles,
    applyText,
    focusAt,
    onPickMention: (name, pubkey) =>
      setMentionPicks((previous) => {
        const next = new Map(previous);
        next.set(name.toLowerCase(), pubkey);
        return next;
      }),
    commands: commandRun.enabled
      ? { matches: commandRun.matches, onRun: commandRun.run }
      : undefined,
  });
  const { namedMembers } = suggest;
  namedMembersRef.current = namedMembers;

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

  /** Insert text at the caret (or the end when the textarea is unfocused). */
  const insertAtCaret = (inserted: string) => {
    const start = Math.min(selection.start, text.length);
    const end = Math.min(selection.end, text.length);
    applyText(`${text.slice(0, start)}${inserted}${text.slice(end)}`);
    focusAt(start + inserted.length);
  };

  /**
   * Insert a chosen GIF's markdown on its own line at the end.
   *
   * Not at the caret, unlike an emoji: a GIF is a block image, and dropping
   * `![…](…)` mid-sentence would split the paragraph the author was typing.
   * GIFs remain visible markdown in the box — unlike uploaded attachments,
   * whose markdown is composed invisibly at send (`composeSendContent`).
   */
  const insertGif = (markdown: string) => {
    const current = textRef.current;
    const separator = current === "" || current.endsWith("\n") ? "" : "\n";
    const next = `${current}${separator}${markdown}\n`;
    applyText(next);
    focusAt(next.length);
  };

  /**
   * Append one finalized dictation utterance at the end of the draft.
   *
   * The mic button is rendered by the route (on the actions row), so this is
   * the handle it writes through — see `ComposerHandle`. The whole insert
   * goes through `applyText`, so the parent's typing notification and the
   * draft persistence see dictated text exactly as typed text.
   */
  const appendDictation = useCallback(
    (chunk: string) => {
      const trimmed = chunk.trim();
      if (trimmed === "") {
        return;
      }
      const current = textRef.current;
      const needsSpace = current.length > 0 && !/\s$/.test(current) ? " " : "";
      const next = `${current}${needsSpace}${trimmed}`;
      applyText(next);
      focusAt(next.length);
    },
    [applyText, focusAt],
  );
  const prefill = useCallback(
    (next: string) => {
      applyText(next);
      focusAt(next.length);
    },
    [applyText, focusAt],
  );

  const focus = useCallback(() => focusAt(textRef.current.length), [focusAt]);
  useImperativeHandle(ref, () => ({ appendDictation, prefill, focus }), [
    appendDictation,
    prefill,
    focus,
  ]);

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

  const { uploadsPending, hasUploaded } = queue;

  // Sender-authored link previews. Editing an existing message never
  // re-resolves: the snapshot belongs to the original send, and an edit that
  // silently swapped it would rewrite what recipients already saw.
  const linkPreviews = useComposerLinkPreviews(editingActive ? "" : text);

  const submit = async () => {
    const trimmed = text.trim();
    // A slash line is a COMMAND and is never sent as message text: run it,
    // or refuse it with an inline error, and stop. This sits before every
    // other branch of submit on purpose — nothing below it may see the draft.
    if (commandRun.intercept(text, busy)) {
      return;
    }
    // Attachment markdown is wire-only; edits keep the original body.
    const finalContent = editingActive
      ? trimmed
      : composeSendContent(
          trimmed,
          uploadedDescriptors(attachments),
          filenamesByUrl(attachments),
        );
    if (!finalContent || busy || uploadsPending) {
      return;
    }
    const { mentionPubkeys: resolved, unresolved } = resolveMentions(
      trimmed,
      namedMembers,
      mentionPicks,
      selfPubkey ?? undefined,
    );
    // The two-person-thread auto-tag rides the SAME p-tag set as the typed
    // mentions, deduped against them (p-tags are a set — if the author also
    // @typed the other participant, one tag goes out, not two). Explicit
    // picks keep their position; the automatic key appends. It is a
    // send-payload addition only — no @ token is written into the content —
    // and absent when `autoNotify` is null (no single partner or agent).
    const autoEntry = autoNotify ? autoNotify.pubkey : null;
    const mentionPubkeys =
      autoEntry &&
      !resolved.some(
        (pubkey) => pubkey.toLowerCase() === autoEntry.toLowerCase(),
      )
        ? [...resolved, autoEntry]
        : resolved;
    if (strictMentions && unresolved.length > 0) {
      toast.error(
        `Resolve huddle mention: ${unresolved.join(", ")}. Choose a member from the @ suggestions.`,
      );
      return;
    }
    setBusy(true);
    try {
      const result = editingActive
        ? ((await editSend?.(trimmed)) ?? { ok: false, message: "" })
        : await send({
            content: finalContent,
            mentionPubkeys,
            // No prop = top-level post. Null on the wire, not undefined, so
            // the send path keeps one shape for "not a reply".
            threadRef: threadRef ?? null,
            // Media tags are derived from final content and appended verbatim
            // by sendChannelMessage, covering imeta and NIP-30 emoji tags.
            mediaTags: [
              ...uploadedDescriptors(attachments).map((descriptor) =>
                buildImetaTag(descriptor),
              ),
              ...buildCustomEmojiTags(finalContent, customEmoji),
              // Link-preview snapshots, or the `["link-preview","none"]`
              // marker when the author dismissed the tray. Derived from the
              // FINAL content, like the emoji tags above: a snapshot whose
              // canonical URL is not in the body is rejected by the relay,
              // and it would take the whole message with it.
              ...linkPreviews.tagsFor(finalContent),
            ],
          });
      if (result.ok) {
        queue.clear();
        applyText("");
        setMentionPicks(new Map());
        linkPreviews.reset();
        if (editingActive) {
          onCancelEdit?.();
        }
        onSent?.();
      } else {
        throw new Error(result.message || "The relay rejected the message.");
      }
    } catch (error) {
      notify.sendFailure(error, submitRef); // verbatim, sticky, Retry
    } finally {
      setBusy(false);
      if (unresolved.length > 0) {
        toast.message(
          `Sent without p-tags for: ${unresolved.join(", ")} (no unique member match)`,
        );
      }
    }
  };

  const submitRef = useRef(submit);
  submitRef.current = submit;
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggest.onKeyDown(event)) {
      return;
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
      onClearThread?.();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      if (returnInsertsNewline(window.matchMedia?.bind(window))) return;
      event.preventDefault();
      void submit();
    }
  };

  const inline = variant === "inline";
  const working = busy || commandRun.running;

  return (
    // A pointer-only drop target (the spread handlers): drag-and-drop has no
    // keyboard equivalent; the paperclip is the keyboard-accessible attach.
    <div
      className={cn(
        "relative",
        !inline &&
          "border-t border-border px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:border-t-0 md:px-5 md:pt-1 md:pb-3.5",
      )}
      {...queue.dropHandlers}
    >
      {queue.dragDepth > 0 && (
        <div
          data-testid="composer-drop-overlay"
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-full z-10 mb-1 flex items-center justify-center rounded-lg border border-dashed border-ring/70 bg-card/95 px-3 py-2 text-sm text-foreground shadow-lg"
        >
          {queue.dragCount > 0
            ? `Drop to attach — ${queue.dragCount} ${queue.dragCount === 1 ? "file" : "files"}`
            : "Drop files to attach"}
        </div>
      )}
      {status}
      <ComposerSuggestionLists
        {...suggest.listProps}
        onPickCommand={
          commandRun.enabled ? suggest.listProps.onPickCommand : undefined
        }
        commandContext={commandContext}
      />
      {editingActive ? (
        <ComposerEditBanner onCancel={() => onCancelEdit?.()} />
      ) : threadRef && replyTarget ? (
        <ComposerReplyBanner
          author={replyTarget.author}
          body={replyTarget.body}
          onDismiss={() => onClearThread?.()}
        />
      ) : null}
      {!editingActive && (
        <ComposerAttachmentTray
          attachments={attachments}
          onRemove={queue.removeQueued}
        />
      )}
      {!editingActive && (
        <ComposerLinkPreviewTray
          cards={linkPreviews.cards}
          onSuppress={linkPreviews.suppress}
        />
      )}
      <input
        ref={queue.fileInputRef}
        type="file"
        accept={ATTACHMENT_ACCEPT}
        multiple
        className="hidden"
        onChange={(event) => void queue.attach(event.target.files)}
      />
      <ComposerFrame
        variant={inline ? "inline" : "default"}
        busy={working}
        editing={editingActive}
        canSend={
          !working && !uploadsPending && (text.trim() !== "" || hasUploaded)
        }
        sendTitle={uploadsPending ? "Waiting for uploads to finish" : undefined}
        commandsEnabled={commandRun.enabled && !editingActive}
        commandListOpen={suggest.commandListOpen}
        actionsBar={editingActive ? null : actionsBar}
        formatToolbar={
          editingActive ? null : (
            <ComposerFormatToolbar
              className="mb-0"
              marks={marks}
              disabled={busy}
              onApply={applyFormat}
              onCaptureSelection={syncSelection}
            />
          )
        }
        onSubmit={() => void submit()}
        onAttach={() => queue.fileInputRef.current?.click()}
        onMention={() => {
          insertAtCaret("@");
          suggest.rearmMention();
        }}
        onCommand={() => {
          applyText("/");
          focusAt(1);
        }}
        onEmoji={insertAtCaret}
        onGif={insertGif}
      >
        <textarea
          ref={textareaRef}
          data-testid="composer-input"
          className={cn(
            "block min-w-0 flex-1 resize-none overflow-y-auto bg-transparent placeholder:text-muted-foreground focus-visible:outline-hidden",
            inline
              ? "max-h-40 min-h-7.5 px-2.5 py-1.5 text-sm"
              : "max-h-60 min-h-11 px-3.5 py-2.5 text-base md:min-h-10 md:w-full md:pt-3 md:pb-1",
          )}
          placeholder={placeholder}
          aria-description={
            autoNotify && !editingActive
              ? `${autoNotify.label} will be notified`
              : undefined
          }
          rows={1}
          value={text}
          onChange={(event) => {
            applyText(event.target.value);
            commandRun.clearError();
            suggest.resetHighlight();
            syncSelection();
          }}
          onKeyDown={onKeyDown}
          onKeyUp={syncSelection}
          onClick={syncSelection}
          onSelect={syncSelection}
          onFocus={syncSelection}
          onPaste={queue.onPaste}
          onBlur={suggest.resetHighlight}
        />
      </ComposerFrame>
      {commandRun.error && (
        <p
          role="alert"
          data-testid="composer-command-error"
          className="mt-1.5 px-1 text-xs font-medium text-coral-ink"
        >
          {commandRun.error}
        </p>
      )}
    </div>
  );
}
