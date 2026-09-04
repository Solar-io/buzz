import { useEffect, useState } from "react";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { EmojiPicker } from "@/shared/ui/EmojiPicker";
import { Input } from "@/shared/ui/input";
import { StatusEmoji } from "./StatusEmoji";

/** The desktop's preset row, verbatim — same statuses, same glyphs. */
const PRESETS = [
  { text: "In a meeting", emoji: "🗣️" },
  { text: "Commuting", emoji: "🚌" },
  { text: "Out sick", emoji: "🤒" },
  { text: "Vacationing", emoji: "🏖️" },
  { text: "Working remotely", emoji: "🏠" },
] as const;

export interface SetStatusDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialText?: string;
  initialEmoji?: string;
  /** Publish; blank text with a blank emoji is a clear. */
  onSave: (text: string, emoji: string) => void;
  onClear: () => void;
  /** Whether the Clear action has anything to clear. */
  hasExistingStatus: boolean;
  /** Set while a publish is in flight — the buttons stay put but go inert. */
  saving?: boolean;
}

/**
 * Set or clear the viewer's NIP-38 status (emoji + text).
 *
 * Mirrors the desktop's dialog — presets, an emoji button with its own clear
 * affordance, Enter to save — against the web client's own UI kit. Clearing
 * is a first-class action rather than "save an empty status", because that is
 * how it reads to the user even though on the wire the two are the same
 * empty kind:30315 event.
 */
export function SetStatusDialog({
  open,
  onOpenChange,
  initialText = "",
  initialEmoji = "",
  onSave,
  onClear,
  hasExistingStatus,
  saving = false,
}: SetStatusDialogProps) {
  const [text, setText] = useState(initialText);
  const [emoji, setEmoji] = useState(initialEmoji);

  // Reopening shows what is live now, not what was typed last time.
  useEffect(() => {
    if (open) {
      setText(initialText);
      setEmoji(initialEmoji);
    }
  }, [open, initialText, initialEmoji]);

  const save = () => {
    onSave(text.trim(), emoji);
    onOpenChange(false);
  };

  const clear = () => {
    onClear();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-[420px]"
        data-testid="set-status-dialog"
      >
        <DialogHeader>
          <DialogTitle>Set a status</DialogTitle>
          <DialogDescription>
            Let others know what you're up to.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 pt-2">
          <div className="flex items-center gap-2">
            <span className="relative shrink-0">
              <EmojiPicker
                label="Choose status emoji"
                onSelect={(selected) => setEmoji(selected)}
              >
                {(props) => (
                  <button
                    aria-label={props["aria-label"]}
                    className={cn(
                      "flex size-9 items-center justify-center rounded-md border border-input text-base",
                      "transition-colors hover:bg-accent",
                    )}
                    data-testid="set-status-emoji"
                    onClick={props.onClick}
                    ref={props.ref}
                    type="button"
                  >
                    {emoji ? <StatusEmoji value={emoji} /> : "💬"}
                  </button>
                )}
              </EmojiPicker>
              {emoji && (
                <button
                  aria-label="Clear status emoji"
                  className={cn(
                    "absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full",
                    "border border-background bg-muted text-3xs leading-none text-muted-foreground",
                    "hover:bg-accent hover:text-foreground",
                  )}
                  data-testid="set-status-emoji-clear"
                  onClick={() => setEmoji("")}
                  type="button"
                >
                  ×
                </button>
              )}
            </span>
            <Input
              autoFocus
              data-testid="set-status-input"
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  save();
                }
              }}
              placeholder="What's your status?"
              value={text}
            />
          </div>

          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((preset) => (
              <button
                className={cn(
                  "rounded-full border border-input px-2.5 py-1 text-xs text-muted-foreground",
                  "transition-colors hover:bg-accent hover:text-foreground",
                )}
                data-testid={`set-status-preset-${preset.text
                  .toLowerCase()
                  .replace(/\s+/g, "-")}`}
                key={preset.text}
                onClick={() => {
                  setText(preset.text);
                  setEmoji(preset.emoji);
                }}
                type="button"
              >
                {preset.emoji} {preset.text}
              </button>
            ))}
          </div>

          <div className="flex items-center justify-between gap-2 pt-1">
            <div>
              {hasExistingStatus && (
                <Button
                  data-testid="set-status-clear"
                  disabled={saving}
                  onClick={clear}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Clear status
                </Button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button
                data-testid="set-status-cancel"
                onClick={() => onOpenChange(false)}
                size="sm"
                type="button"
                variant="ghost"
              >
                Cancel
              </Button>
              <Button
                data-testid="set-status-save"
                disabled={saving || (!text.trim() && !emoji)}
                onClick={save}
                size="sm"
                type="button"
              >
                Save
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
