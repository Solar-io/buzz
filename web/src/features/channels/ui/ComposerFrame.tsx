import { type ReactNode, useState } from "react";
import {
  ArrowUp,
  AtSign,
  Paperclip,
  Smile,
  SquareSlash,
  Type,
} from "lucide-react";
import { cn } from "@/shared/lib/cn";
import { EmojiPicker } from "@/shared/ui/EmojiPicker";

const FORMAT_OPEN_KEY = "buzz.composer.format-open.v1";

function loadFormatOpen(): boolean {
  try {
    return globalThis.localStorage?.getItem(FORMAT_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

function saveFormatOpen(open: boolean): void {
  try {
    globalThis.localStorage?.setItem(FORMAT_OPEN_KEY, open ? "1" : "0");
  } catch {
    // Session-local when storage is unavailable.
  }
}

const TOOL =
  "size-7.5 shrink-0 place-items-center rounded-[7px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

function Key({ children }: { children: ReactNode }) {
  return (
    <span className="rounded bg-chip px-1 font-mono text-2xs font-semibold text-ink-2">
      {children}
    </span>
  );
}

function SendButton({
  label,
  title,
  disabled,
  onClick,
  className,
}: {
  label: string;
  title?: string;
  disabled: boolean;
  onClick: () => void;
  className: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "shrink-0 place-items-center bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40",
        className,
      )}
    >
      <ArrowUp aria-hidden className="size-4" strokeWidth={2.2} />
    </button>
  );
}

/**
 * The composer's visual frame (web redesign Phase 2). It owns no draft
 * state — `Composer.tsx` passes the textarea as `children` and the handlers
 * for every control — only how the box is laid out:
 *
 * - **default, md and up** (Main artboard): one rounded card — the field,
 *   then a tool row: mention, attach, commands, emoji, formatting, a hint,
 *   the channel's own controls and Send. The formatting toolbar is folded
 *   behind its toggle so the resting composer is one line and a row of quiet
 *   icons; the choice is remembered per device.
 * - **default, below md** (PhoneChannel artboard): `/` · field · Send on one
 *   row of 44 px targets, with attach inside the field. The channel's
 *   controls are in the phone top bar there.
 * - **inline**: the thread reply box — a slim field and a small Send that
 *   appears once there is something to send.
 *
 * The hint swaps to the list's keys while the command list is open, because
 * that is the moment Tab and Enter mean something different.
 */
export function ComposerFrame({
  variant,
  busy,
  editing,
  canSend,
  sendTitle,
  commandsEnabled,
  commandListOpen,
  actionsBar,
  formatToolbar,
  onSubmit,
  onAttach,
  onMention,
  onCommand,
  onEmoji,
  onGif,
  children,
}: {
  variant: "default" | "inline";
  busy: boolean;
  editing: boolean;
  canSend: boolean;
  sendTitle?: string;
  commandsEnabled: boolean;
  commandListOpen: boolean;
  actionsBar?: ReactNode;
  /** The B/I/S… toolbar; null while editing. */
  formatToolbar?: ReactNode;
  onSubmit: () => void;
  onAttach: () => void;
  onMention: () => void;
  onCommand: () => void;
  onEmoji: (emoji: string) => void;
  onGif: (markdown: string) => void;
  /** The textarea. */
  children: ReactNode;
}) {
  const [formatOpen, setFormatOpen] = useState(() => loadFormatOpen());
  const sendLabel = editing ? "Save" : "Send";

  if (variant === "inline") {
    return (
      <div className="flex items-end gap-1 rounded-lg border border-border bg-card pr-1 transition-colors focus-within:border-line-2 focus-within:ring-2 focus-within:ring-chip">
        {children}
        <SendButton
          label={sendLabel}
          title={sendTitle}
          disabled={!canSend}
          onClick={onSubmit}
          className="mb-[3px] grid size-6 rounded-md disabled:opacity-0"
        />
      </div>
    );
  }

  return (
    <div className="flex items-end gap-1.5 md:block">
      {commandsEnabled && (
        <button
          type="button"
          aria-label="Commands"
          title="Commands"
          disabled={busy}
          onClick={onCommand}
          className="grid size-11 shrink-0 place-items-center rounded-xl border border-border bg-card font-mono text-lg font-semibold text-ink-2 hover:bg-accent md:hidden"
        >
          /
        </button>
      )}
      <div
        data-testid="composer-box"
        className={cn(
          "flex min-w-0 flex-1 items-end rounded-xl border border-input bg-card transition-colors md:block md:rounded-[14px] md:shadow-[0_12px_24px_-18px_var(--elev-shadow)]",
          "focus-within:border-foreground/70 focus-within:ring-[3px] focus-within:ring-chip",
        )}
      >
        {formatOpen && formatToolbar ? (
          <div className="hidden border-b border-border px-2 py-1.5 md:block">
            {formatToolbar}
          </div>
        ) : null}
        {children}
        <div
          className="flex shrink-0 items-center gap-0.5 pr-1 pb-1.5 md:px-2 md:pt-1 md:pb-2"
          role="toolbar"
          aria-label="Insert"
        >
          <button
            type="button"
            aria-label="Mention someone"
            title="Mention — inserts @"
            className={cn(TOOL, "hidden md:grid")}
            disabled={busy || editing}
            onClick={onMention}
          >
            <AtSign aria-hidden className="size-4" />
          </button>
          <button
            type="button"
            aria-label="Attach a file"
            title="Attach images, video or files — or paste a screenshot"
            className={cn(TOOL, "grid")}
            disabled={busy}
            onClick={onAttach}
          >
            <Paperclip aria-hidden className="size-4" />
          </button>
          {commandsEnabled && (
            <button
              type="button"
              aria-label="Commands"
              title="Commands — inserts /"
              className={cn(TOOL, "hidden md:grid")}
              disabled={busy}
              onClick={onCommand}
            >
              <SquareSlash aria-hidden className="size-4" />
            </button>
          )}
          <EmojiPicker
            label="Insert emoji"
            onSelect={onEmoji}
            onSelectGif={onGif}
          >
            {(props) => (
              <button
                type="button"
                ref={props.ref}
                aria-label={props["aria-label"]}
                title="Insert emoji"
                className={cn(TOOL, "hidden md:grid")}
                disabled={busy || editing}
                onClick={props.onClick}
              >
                <Smile aria-hidden className="size-4" />
              </button>
            )}
          </EmojiPicker>
          {formatToolbar ? (
            <button
              type="button"
              aria-label={formatOpen ? "Hide formatting" : "Show formatting"}
              aria-pressed={formatOpen}
              title="Formatting"
              className={cn(
                TOOL,
                "hidden md:grid",
                formatOpen && "bg-chip text-foreground",
              )}
              onClick={() =>
                setFormatOpen((open) => {
                  saveFormatOpen(!open);
                  return !open;
                })
              }
            >
              <Type aria-hidden className="size-4" />
            </button>
          ) : null}
          {commandsEnabled && (
            <span
              data-testid="composer-hint"
              className="ml-1.5 hidden min-w-0 truncate text-xs text-muted-foreground xl:block"
            >
              {commandListOpen ? (
                <span className="font-mono text-2xs">
                  ↑↓ choose · Tab complete · ↵ run · Esc close
                </span>
              ) : (
                <>
                  Type <Key>/</Key> for commands · <Key>@</Key> to hand work to
                  a seat
                </>
              )}
            </span>
          )}
          <div className="ml-auto hidden shrink-0 items-center gap-1.5 pl-2 md:flex">
            {actionsBar}
            <SendButton
              label={sendLabel}
              title={sendTitle}
              disabled={!canSend}
              onClick={onSubmit}
              className="grid size-8 rounded-[9px]"
            />
          </div>
        </div>
      </div>
      <SendButton
        label={sendLabel}
        title={sendTitle}
        disabled={!canSend}
        onClick={onSubmit}
        className="grid size-11 rounded-xl md:hidden"
      />
    </div>
  );
}
