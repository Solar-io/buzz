import { useEffect, useState } from "react";

import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";

import type { ShortcutDef, ShortcutMode } from "../lib/shortcutBlob.ts";

/**
 * Add or edit a shortcut.
 *
 * A clone of the dock's AddSiteDialog (same error-row pattern, same trust
 * warning adapted for the two modes) with one addition: the mode picker.
 * Native radio inputs wrapped in labels — the repo has no
 * `@radix-ui/react-radio-group` dependency, and two radios need none.
 */
export function ShortcutDialog({
  open,
  editing,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  /** The shortcut being edited, or null for an add. */
  editing: ShortcutDef | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (input: {
    url: string;
    label: string;
    mode: ShortcutMode;
  }) => Promise<{ ok: true } | { ok: false; reason: string }>;
}) {
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [mode, setMode] = useState<ShortcutMode>("overlay");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setUrl(editing?.url ?? "");
      setLabel(editing?.label ?? "");
      setMode(editing?.mode ?? "overlay");
      setError(null);
    }
  }, [open, editing]);

  // A save is a publish round-trip, so confirm is async: the dialog stays
  // open (and shows the reason) until the relay answers or a guard refuses.
  const submit = async () => {
    setSubmitting(true);
    try {
      const result = await onConfirm({ url, label, mode });
      if (result.ok) {
        onOpenChange(false);
        return;
      }
      setError(result.reason);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-md" data-testid="shortcut-dialog">
        <DialogHeader>
          <DialogTitle>
            {editing ? "Edit shortcut" : "Add a shortcut"}
          </DialogTitle>
          <DialogDescription>
            {editing
              ? "Update where this shortcut points and how it opens."
              : "It appears in your sidebar, below Forums, for you only."}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Input
            aria-label="Address"
            autoComplete="off"
            data-testid="shortcut-url"
            onChange={(event) => {
              setUrl(event.target.value);
              setError(null);
            }}
            placeholder="https://kept.your-network/"
            spellCheck={false}
            value={url}
          />
          <Input
            aria-label="Label"
            autoComplete="off"
            data-testid="shortcut-label"
            maxLength={64}
            onChange={(event) => {
              setLabel(event.target.value);
              setError(null);
            }}
            placeholder="Label"
            value={label}
          />
          <fieldset className="flex gap-4">
            <legend className="sr-only">How the shortcut opens</legend>
            <label className="flex items-center gap-1.5 text-xs">
              <input
                checked={mode === "overlay"}
                data-testid="shortcut-mode-overlay"
                name="shortcut-mode"
                onChange={() => setMode("overlay")}
                type="radio"
              />
              Overlay here
            </label>
            <label className="flex items-center gap-1.5 text-xs">
              <input
                checked={mode === "window"}
                data-testid="shortcut-mode-window"
                name="shortcut-mode"
                onChange={() => setMode("window")}
                type="radio"
              />
              New browser tab
            </label>
          </fieldset>
          {error ? (
            <p
              className="text-xs text-destructive"
              data-testid="shortcut-error"
            >
              {error}
            </p>
          ) : null}
          <p className="text-2xs text-muted-foreground">
            Overlay mode embeds the site in this page — only add sites you
            trust, and expect some to refuse embedding altogether. New-tab mode
            opens it in a regular browser tab instead.
          </p>
          <div className="flex justify-end gap-2">
            <Button
              onClick={() => onOpenChange(false)}
              size="sm"
              type="button"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              data-testid="shortcut-submit"
              disabled={submitting || url.trim().length === 0}
              size="sm"
              type="submit"
            >
              {editing ? "Save" : "Add"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
