/**
 * Channel templates settings card — the web counterpart of the desktop's
 * `ChannelTemplatesSettingsCard`.
 *
 * Two things the desktop card does not do, added because they are what makes
 * templates useful when the store is per-client: export writes the desktop's
 * exact `channel-templates.json`, and import reads it. That turns a
 * browser-local store into something you can move to your desktop rather than
 * a second, stranded copy.
 */

import { useRef, useState } from "react";
import { Copy, Download, Pencil, Play, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";

import {
  serializeTemplates,
  type ChannelTemplate,
} from "../lib/templateModel.ts";
import { parseTemplatesFile } from "../templateStore.ts";
import {
  useChannelTemplates,
  useRosterCatalog,
  useTeamNames,
} from "../useChannelTemplates";
import {
  NewTemplateButton,
  TemplateEditorDialog,
} from "./TemplateEditorDialog";
import { UseTemplateDialog } from "./UseTemplateDialog";

const EXPORT_FILE_NAME = "channel-templates.json";

function download(fileName: string, text: string) {
  const url = URL.createObjectURL(
    new Blob([text], { type: "application/json" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function TemplateRow({
  onDelete,
  onDuplicate,
  onEdit,
  onUse,
  teamNames,
  template,
}: {
  onDelete: () => void;
  onDuplicate: () => void;
  onEdit: () => void;
  onUse: () => void;
  teamNames: Map<string, string>;
  template: ChannelTemplate;
}) {
  const agentCount =
    template.agents.personas.length + template.agents.teams.length;
  const teamLabels = template.agents.teams
    .map((entry) => teamNames.get(entry.teamId) ?? entry.teamId)
    .join(", ");

  return (
    <li
      className="space-y-2 rounded-md border border-border p-3"
      data-testid={`channel-template-${template.id}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium">{template.name}</span>
            <Badge variant="outline">
              {template.channelType === "forum" ? "Forum" : "Stream"}
            </Badge>
            <Badge
              variant={
                template.visibility === "private" ? "secondary" : "outline"
              }
            >
              {template.visibility === "private" ? "Private" : "Open"}
            </Badge>
            {template.isBuiltin ? <Badge variant="info">Built-in</Badge> : null}
          </div>
          {template.description ? (
            <p className="mt-1 text-sm text-muted-foreground">
              {template.description}
            </p>
          ) : null}
          <p className="mt-1 text-xs text-muted-foreground/70">
            {agentCount === 0
              ? "No agents"
              : `${agentCount} agent entr${agentCount === 1 ? "y" : "ies"}${teamLabels ? ` — teams: ${teamLabels}` : ""}`}
            {template.canvasTemplate ? " · carries a canvas" : ""}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-1">
        <Button onClick={onUse} size="sm">
          <Play className="mr-1 h-3.5 w-3.5" />
          Use
        </Button>
        <Button onClick={onEdit} size="sm" variant="ghost">
          <Pencil className="mr-1 h-3.5 w-3.5" />
          Edit
        </Button>
        <Button onClick={onDuplicate} size="sm" variant="ghost">
          <Copy className="mr-1 h-3.5 w-3.5" />
          Duplicate
        </Button>
        {template.isBuiltin ? null : (
          <Button onClick={onDelete} size="sm" variant="ghost">
            <Trash2 className="mr-1 h-3.5 w-3.5" />
            Delete
          </Button>
        )}
      </div>
    </li>
  );
}

export function ChannelTemplatesSettingsCard() {
  const {
    create,
    duplicate,
    importTemplates,
    loaded,
    remove,
    templates,
    update,
  } = useChannelTemplates();
  const catalog = useRosterCatalog();
  const teamNames = useTeamNames();
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [editing, setEditing] = useState<ChannelTemplate | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [using, setUsing] = useState<ChannelTemplate | null>(null);
  const [useOpen, setUseOpen] = useState(false);

  const openCreate = () => {
    setEditing(null);
    setEditorOpen(true);
  };

  const onImportFile = async (file: File) => {
    const parsed = parseTemplatesFile(await file.text());
    if (parsed.length === 0) {
      toast.error("No templates found in that file.");
      return;
    }
    await importTemplates(parsed);
    toast.success(
      `Imported ${parsed.length} template${parsed.length === 1 ? "" : "s"}.`,
    );
  };

  return (
    <section
      className="space-y-3 rounded-lg border border-border bg-card p-4"
      data-testid="channel-templates-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium">Channel templates</h2>
        <div className="flex flex-wrap gap-1">
          <Button
            onClick={() => fileRef.current?.click()}
            size="sm"
            variant="ghost"
          >
            <Upload className="mr-1 h-3.5 w-3.5" />
            Import
          </Button>
          <Button
            disabled={templates.length === 0}
            onClick={() =>
              download(EXPORT_FILE_NAME, serializeTemplates(templates))
            }
            size="sm"
            variant="ghost"
          >
            <Download className="mr-1 h-3.5 w-3.5" />
            Export
          </Button>
          <NewTemplateButton onClick={openCreate} />
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        Reusable shapes for new channels — type, visibility, topic, and an agent
        roster. Stored in this browser, like the desktop stores its own; export
        the file to carry them across.
      </p>

      <input
        accept="application/json,.json"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void onImportFile(file);
        }}
        ref={fileRef}
        type="file"
      />

      {!loaded ? (
        <p className="text-sm text-muted-foreground/70">Loading…</p>
      ) : templates.length === 0 ? (
        <p className="text-sm text-muted-foreground/70">
          No templates yet. Create one, or import a{" "}
          <code className="font-mono text-xs">channel-templates.json</code>{" "}
          exported from Buzz Desktop.
        </p>
      ) : (
        <ul className="space-y-2">
          {templates.map((template) => (
            <TemplateRow
              key={template.id}
              onDelete={() => {
                void remove(template.id).then((error) => {
                  if (error) toast.error(error);
                });
              }}
              onDuplicate={() => {
                void duplicate(template.id).then((error) => {
                  if (error) toast.error(error);
                });
              }}
              onEdit={() => {
                setEditing(template);
                setEditorOpen(true);
              }}
              onUse={() => {
                setUsing(template);
                setUseOpen(true);
              }}
              teamNames={teamNames}
              template={template}
            />
          ))}
        </ul>
      )}

      <TemplateEditorDialog
        catalog={catalog}
        onOpenChange={setEditorOpen}
        onSubmit={(draft) =>
          editing ? update(editing.id, draft) : create(draft)
        }
        open={editorOpen}
        teamNames={teamNames}
        template={editing}
      />
      <UseTemplateDialog
        onOpenChange={setUseOpen}
        open={useOpen}
        template={using}
      />
    </section>
  );
}
