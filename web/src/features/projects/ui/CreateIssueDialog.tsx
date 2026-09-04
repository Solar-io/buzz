/**
 * File a NIP-34 issue (kind:1621) against one repository.
 *
 * The repository is an explicit input, never inferred from the container: a
 * two-repository project would otherwise silently file against the wrong
 * member (NIP-MP, "Route resolution").
 */

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";
import { Textarea } from "@/shared/ui/textarea";
import { useCreateIssue } from "../hooks.ts";
import {
  PROJECT_TASK_CATEGORIES,
  type ProjectTaskCategory,
} from "../lib/projectIssues.ts";
import type { Repository } from "../lib/projectModels.ts";

export function CreateIssueDialog({
  onOpenChange,
  open,
  repository,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
  repository: Repository | null;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [category, setCategory] = useState<ProjectTaskCategory>("issue");
  const createIssue = useCreateIssue(repository);

  useEffect(() => {
    if (!open) {
      setTitle("");
      setBody("");
      setCategory("issue");
    }
  }, [open]);

  const submit = async () => {
    try {
      await createIssue.mutateAsync({ body, labels: [category], title });
      toast.success("Issue filed");
      onOpenChange(false);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not file the issue.",
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New issue</DialogTitle>
          <DialogDescription>
            {repository
              ? `Filed against ${repository.name}.`
              : "Choose a repository first."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <label
              className="text-xs font-medium text-muted-foreground"
              htmlFor="create-issue-title"
            >
              Title
            </label>
            <Input
              autoFocus
              data-testid="create-issue-title"
              id="create-issue-title"
              maxLength={256}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Something is broken"
              value={title}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label
              className="text-xs font-medium text-muted-foreground"
              htmlFor="create-issue-body"
            >
              Description
            </label>
            <Textarea
              data-testid="create-issue-body"
              id="create-issue-body"
              onChange={(event) => setBody(event.target.value)}
              placeholder="Markdown is rendered."
              rows={6}
              value={body}
            />
          </div>

          {/* Radio pills rather than a native select: a `select` popup is an
              OS-level surface that automation cannot drive and screen readers
              announce inconsistently inside a dialog. */}
          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-xs font-medium text-muted-foreground">
              Category
            </legend>
            <div className="flex flex-wrap gap-2">
              {PROJECT_TASK_CATEGORIES.map((option) => (
                <Button
                  data-testid={`create-issue-category-${option.value}`}
                  key={option.value}
                  onClick={() => setCategory(option.value)}
                  size="sm"
                  type="button"
                  variant={category === option.value ? "default" : "outline"}
                >
                  {option.label}
                </Button>
              ))}
            </div>
          </fieldset>
        </div>

        <DialogFooter>
          <Button
            onClick={() => onOpenChange(false)}
            type="button"
            variant="ghost"
          >
            Cancel
          </Button>
          <Button
            data-testid="create-issue-submit"
            disabled={
              !repository || title.trim().length === 0 || createIssue.isPending
            }
            onClick={() => void submit()}
            type="button"
          >
            {createIssue.isPending ? "Filing…" : "File issue"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
