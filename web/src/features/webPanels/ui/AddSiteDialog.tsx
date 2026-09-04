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

/**
 * Add a site to the dock.
 *
 * The warning is not boilerplate. On the desktop each panel is a native child
 * webview, isolated from the app; in a browser it is an iframe inside the
 * origin that holds the user's key. Same-origin isolation does the real work,
 * and `normalizePanelUrl` refuses every scheme that would escape it — but the
 * person adding a site should know what they are embedding.
 */
export function AddSiteDialog({
  open,
  onOpenChange,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (input: {
    url: string;
    label?: string;
  }) => { ok: true } | { ok: false; reason: string };
}) {
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setUrl("");
      setLabel("");
      setError(null);
    }
  }, [open]);

  const submit = () => {
    const result = onAdd({ url, label });
    if (result.ok) {
      onOpenChange(false);
      return;
    }
    setError(result.reason);
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-md" data-testid="add-site-dialog">
        <DialogHeader>
          <DialogTitle>Add a site to the dock</DialogTitle>
          <DialogDescription>
            It opens in a tab beside Files and stays loaded while you switch
            away.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Input
            aria-label="Site address"
            autoComplete="off"
            data-testid="add-site-url"
            onChange={(event) => {
              setUrl(event.target.value);
              setError(null);
            }}
            placeholder="https://files.your-network/"
            spellCheck={false}
            value={url}
          />
          <Input
            aria-label="Name (optional)"
            autoComplete="off"
            data-testid="add-site-label"
            onChange={(event) => setLabel(event.target.value)}
            placeholder="Name (optional)"
            value={label}
          />
          {error ? (
            <p
              className="text-xs text-destructive"
              data-testid="add-site-error"
            >
              {error}
            </p>
          ) : null}
          <p className="text-2xs text-muted-foreground">
            The site is embedded in this page. Only add sites you trust — and
            expect some to refuse embedding altogether, which is their choice,
            not a fault here.
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
              data-testid="add-site-submit"
              disabled={url.trim().length === 0}
              size="sm"
              type="submit"
            >
              Add
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
