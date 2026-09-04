/**
 * Create a channel from a template.
 *
 * This is the only place the web client can create a *forum* — the shell's own
 * New Channel dialog never sends `channel_type`, so everything it makes is a
 * stream. Applying a forum template here sends the tag.
 */

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";

import { canvasBody } from "../lib/applyTemplate.ts";
import type { ChannelTemplate } from "../lib/templateModel.ts";
import { useApplyTemplate } from "../useApplyTemplate";
import { useRosterCatalog } from "../useChannelTemplates";

export function UseTemplateDialog({
  onOpenChange,
  open,
  template,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
  template: ChannelTemplate | null;
}) {
  const catalog = useRosterCatalog();
  const apply = useApplyTemplate();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName("");
      setProgress(null);
      setBusy(false);
    }
  }, [open]);

  const run = async () => {
    if (!template) return;
    setBusy(true);
    const result = await apply({
      template,
      channelName: name,
      catalog,
      onProgress: setProgress,
    });
    setBusy(false);
    setProgress(null);
    if ("error" in result) {
      toast.error(result.error);
      return;
    }
    const parts = [`#${name.trim().replace(/^#+/, "")} created`];
    if (result.provisioned.length > 0) {
      parts.push(`${result.provisioned.length} agent(s) added`);
    }
    toast.success(parts.join(" — "));
    for (const problem of result.problems) toast.warning(problem);
    if (result.skipped.length > 0) {
      toast.warning(
        `Not found in this browser, so skipped: ${result.skipped.join(", ")}`,
      );
    }
    onOpenChange(false);
  };

  const preview = template ? canvasBody(template, name || "new-channel") : null;
  const agentCount =
    (template?.agents.personas.length ?? 0) +
    (template?.agents.teams.length ?? 0);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Use “{template?.name}”</DialogTitle>
          <DialogDescription>
            Creates a {template?.visibility === "private" ? "private" : "open"}{" "}
            {template?.channelType === "forum" ? "forum" : "stream"}
            {agentCount > 0
              ? ` and asks your desktop for ${agentCount} agent entr${agentCount === 1 ? "y" : "ies"}`
              : ""}
            .
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Input
            autoFocus
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && name.trim() && !busy) {
                void run();
              }
            }}
            placeholder="channel name (no spaces)"
            value={name}
          />

          {preview ? (
            <details className="rounded-md border border-border p-2">
              <summary className="cursor-pointer select-none text-xs text-muted-foreground">
                Canvas this template carries (applied on desktop only)
              </summary>
              <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">
                {preview}
              </pre>
            </details>
          ) : null}

          {progress ? (
            <p className="text-sm text-muted-foreground" role="status">
              {progress}
            </p>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button
              disabled={busy}
              onClick={() => onOpenChange(false)}
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              disabled={busy || name.trim().length === 0}
              onClick={() => void run()}
            >
              {busy ? "Working…" : "Create channel"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
