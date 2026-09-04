/**
 * Create a project: one repository announcement plus the NIP-MP project that
 * lists it, signed with the viewer's key.
 *
 * The slug preview is not decoration. `d` is the addressable half of the
 * coordinate — it is what every issue, patch and clone URL will point at, and
 * a replaceable event with the same `d` overwrites this one — so the dialog
 * shows what the typed name will become before anything is signed.
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
import { useCreateProject } from "../hooks.ts";
import { projectDtagFromName } from "../lib/projectEvents.ts";

export function CreateProjectDialog({
  onCreated,
  onOpenChange,
  open,
  ownerPubkey,
}: {
  onCreated?: (projectAddress: string) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  ownerPubkey: string | null;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [cloneUrl, setCloneUrl] = useState("");
  const createProject = useCreateProject();

  useEffect(() => {
    if (!open) {
      setName("");
      setDescription("");
      setCloneUrl("");
    }
  }, [open]);

  const slug = projectDtagFromName(name);
  const canSubmit = Boolean(ownerPubkey) && slug.length > 0;

  const submit = async () => {
    if (!ownerPubkey) return;
    try {
      const result = await createProject.mutateAsync({
        cloneUrl: cloneUrl.trim() || undefined,
        description: description.trim() || undefined,
        name,
        ownerPubkey,
      });
      toast.success(`Created ${name.trim()}`);
      onOpenChange(false);
      onCreated?.(result.projectAddress);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not create the project.",
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            Publishes a repository announcement and the project that groups it.
            Both are signed with your key and replaceable by you alone.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <label
              className="text-xs font-medium text-muted-foreground"
              htmlFor="create-project-name"
            >
              Name
            </label>
            <Input
              autoFocus
              data-testid="create-project-name"
              id="create-project-name"
              onChange={(event) => setName(event.target.value)}
              placeholder="Platform"
              value={name}
            />
            <span className="text-2xs text-muted-foreground">
              {slug ? (
                <>
                  Address:{" "}
                  <code className="font-mono" data-testid="create-project-slug">
                    {slug}
                  </code>
                </>
              ) : (
                "The name needs at least one letter or number."
              )}
            </span>
          </div>

          <div className="flex flex-col gap-1.5">
            <label
              className="text-xs font-medium text-muted-foreground"
              htmlFor="create-project-description"
            >
              Description
            </label>
            <Textarea
              data-testid="create-project-description"
              id="create-project-description"
              onChange={(event) => setDescription(event.target.value)}
              placeholder="What this project is for."
              rows={3}
              value={description}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label
              className="text-xs font-medium text-muted-foreground"
              htmlFor="create-project-clone"
            >
              Clone URL <span className="font-normal">(optional)</span>
            </label>
            <Input
              data-testid="create-project-clone"
              id="create-project-clone"
              onChange={(event) => setCloneUrl(event.target.value)}
              placeholder="https://example.com/owner/repo.git"
              value={cloneUrl}
            />
            <span className="text-2xs text-muted-foreground">
              Leave empty to use this relay&rsquo;s own git host.
            </span>
          </div>
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
            data-testid="create-project-submit"
            disabled={!canSubmit || createProject.isPending}
            onClick={() => void submit()}
            type="button"
          >
            {createProject.isPending ? "Creating…" : "Create project"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
