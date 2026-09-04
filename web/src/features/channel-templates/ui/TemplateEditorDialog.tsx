/**
 * Create / edit one channel template.
 *
 * The roster half only offers personas and teams this client can actually see
 * (live 30175 / 30176), because a template naming a persona that does not
 * exist provisions nothing and says nothing about why.
 */

import { useEffect, useMemo, useState } from "react";
import { Plus, X } from "lucide-react";

import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";
import { Textarea } from "@/shared/ui/textarea";
import { cn } from "@/shared/lib/cn";

import {
  draftFromTemplate,
  emptyDraft,
  type ChannelTemplate,
  type ChannelTemplateDraft,
  type ChannelTemplateType,
  type ChannelTemplateVisibility,
} from "../lib/templateModel.ts";
import type { RosterCatalog } from "../useChannelTemplates";

const selectClass = cn(
  "h-9 w-full rounded-md border border-input bg-background px-2 text-sm",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
);

function FieldLabel({
  children,
  htmlFor,
}: {
  children: React.ReactNode;
  htmlFor: string;
}) {
  return (
    <label className="block text-sm font-medium" htmlFor={htmlFor}>
      {children}
    </label>
  );
}

export function TemplateEditorDialog({
  catalog,
  onOpenChange,
  onSubmit,
  open,
  teamNames,
  template,
}: {
  catalog: RosterCatalog;
  onOpenChange: (open: boolean) => void;
  /** Returns an error string, or null when the save succeeded. */
  onSubmit: (draft: ChannelTemplateDraft) => Promise<string | null>;
  open: boolean;
  teamNames: Map<string, string>;
  /** null = create a new template. */
  template: ChannelTemplate | null;
}) {
  const [draft, setDraft] = useState<ChannelTemplateDraft>(() =>
    template ? draftFromTemplate(template) : emptyDraft(),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Re-seed whenever the dialog opens on a different row: the component stays
  // mounted between opens, so state would otherwise carry the last edit over.
  useEffect(() => {
    if (open) {
      setDraft(template ? draftFromTemplate(template) : emptyDraft());
      setError(null);
    }
  }, [open, template]);

  const personaById = useMemo(
    () => new Map(catalog.personas.map((persona) => [persona.id, persona])),
    [catalog.personas],
  );

  const unusedPersonas = catalog.personas.filter(
    (persona) =>
      !draft.agents.personas.some((entry) => entry.personaId === persona.id),
  );
  const unusedTeams = catalog.teams.filter(
    (team) => !draft.agents.teams.some((entry) => entry.teamId === team.id),
  );

  const addPersona = (personaId: string) => {
    if (!personaId) return;
    setDraft((current) => ({
      ...current,
      agents: {
        ...current.agents,
        personas: [
          ...current.agents.personas,
          { personaId, runtime: null, model: null, role: "bot", backend: null },
        ],
      },
    }));
  };

  const addTeam = (teamId: string) => {
    if (!teamId) return;
    setDraft((current) => ({
      ...current,
      agents: {
        ...current.agents,
        teams: [
          ...current.agents.teams,
          { teamId, runtime: null, model: null, backend: null },
        ],
      },
    }));
  };

  const save = async () => {
    setBusy(true);
    const issue = await onSubmit(draft);
    setBusy(false);
    if (issue) {
      setError(issue);
      return;
    }
    onOpenChange(false);
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {template ? "Edit template" : "New channel template"}
          </DialogTitle>
          <DialogDescription>
            A template is stored in this browser only, the same way the desktop
            keeps its own. Export it to move it between clients.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <FieldLabel htmlFor="template-name">Name</FieldLabel>
            <Input
              autoFocus
              id="template-name"
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  name: event.target.value,
                }))
              }
              placeholder="Sprint planning"
              value={draft.name}
            />
          </div>

          <div className="space-y-1.5">
            <FieldLabel htmlFor="template-description">
              Description — becomes the channel topic
            </FieldLabel>
            <Input
              id="template-description"
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  description: event.target.value,
                }))
              }
              placeholder="What is this channel for?"
              value={draft.description}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <FieldLabel htmlFor="template-type">Channel type</FieldLabel>
              <select
                className={selectClass}
                id="template-type"
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    channelType: event.target.value as ChannelTemplateType,
                  }))
                }
                value={draft.channelType}
              >
                <option value="stream">Stream</option>
                <option value="forum">Forum</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <FieldLabel htmlFor="template-visibility">Visibility</FieldLabel>
              <select
                className={selectClass}
                id="template-visibility"
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    visibility: event.target.value as ChannelTemplateVisibility,
                  }))
                }
                value={draft.visibility}
              >
                <option value="open">Open</option>
                <option value="private">Private (invite only)</option>
              </select>
            </div>
          </div>

          <section className="space-y-2 rounded-md border border-border p-3">
            <p className="text-sm font-medium">Agents</p>
            <p className="text-xs text-muted-foreground">
              Personas and teams to provision when the template is used. Your
              desktop creates them and this browser adds them to the channel.
            </p>

            {draft.agents.personas.length === 0 &&
            draft.agents.teams.length === 0 ? (
              <p className="text-xs text-muted-foreground/70">
                No agents — the template just shapes the channel.
              </p>
            ) : null}

            <ul className="space-y-1">
              {draft.agents.personas.map((entry, index) => (
                <li
                  className="flex items-center justify-between gap-2 rounded-md bg-muted/50 px-2 py-1.5 text-sm"
                  key={`persona-${entry.personaId}`}
                >
                  <span className="truncate">
                    {personaById.get(entry.personaId)?.name ?? entry.personaId}
                  </span>
                  <Button
                    aria-label={`Remove ${entry.personaId}`}
                    onClick={() =>
                      setDraft((current) => ({
                        ...current,
                        agents: {
                          ...current.agents,
                          personas: current.agents.personas.filter(
                            (_, i) => i !== index,
                          ),
                        },
                      }))
                    }
                    size="icon"
                    variant="ghost"
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </li>
              ))}
              {draft.agents.teams.map((entry, index) => (
                <li
                  className="flex items-center justify-between gap-2 rounded-md bg-muted/50 px-2 py-1.5 text-sm"
                  key={`team-${entry.teamId}`}
                >
                  <span className="truncate">
                    Team: {teamNames.get(entry.teamId) ?? entry.teamId}
                  </span>
                  <Button
                    aria-label={`Remove team ${entry.teamId}`}
                    onClick={() =>
                      setDraft((current) => ({
                        ...current,
                        agents: {
                          ...current.agents,
                          teams: current.agents.teams.filter(
                            (_, i) => i !== index,
                          ),
                        },
                      }))
                    }
                    size="icon"
                    variant="ghost"
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </li>
              ))}
            </ul>

            <div className="grid grid-cols-2 gap-2">
              <select
                aria-label="Add a persona"
                className={selectClass}
                onChange={(event) => {
                  addPersona(event.target.value);
                  event.target.value = "";
                }}
                value=""
              >
                <option value="">
                  {catalog.personas.length === 0
                    ? "No personas yet"
                    : "Add a persona…"}
                </option>
                {unusedPersonas.map((persona) => (
                  <option key={persona.id} value={persona.id}>
                    {persona.name}
                  </option>
                ))}
              </select>
              <select
                aria-label="Add a team"
                className={selectClass}
                onChange={(event) => {
                  addTeam(event.target.value);
                  event.target.value = "";
                }}
                value=""
              >
                <option value="">
                  {catalog.teams.length === 0 ? "No teams yet" : "Add a team…"}
                </option>
                {unusedTeams.map((team) => (
                  <option key={team.id} value={team.id}>
                    {teamNames.get(team.id) ?? team.id}
                  </option>
                ))}
              </select>
            </div>
          </section>

          <div className="space-y-1.5">
            <FieldLabel htmlFor="template-canvas">
              Canvas (desktop only)
            </FieldLabel>
            <Textarea
              id="template-canvas"
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  canvasTemplate: event.target.value,
                }))
              }
              placeholder={"# {channel.name}\n\nAgenda…"}
              rows={4}
              value={draft.canvasTemplate}
            />
            <p className="text-xs text-muted-foreground/70">
              Buzz on the web has no canvas surface, so this is stored and
              exported but never applied here. `{"{channel.name}"}` and `
              {"{template.name}"}` are substituted when the desktop applies it.
            </p>
          </div>

          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button onClick={() => onOpenChange(false)} variant="ghost">
              Cancel
            </Button>
            <Button
              disabled={busy || draft.name.trim().length === 0}
              onClick={() => void save()}
            >
              {busy ? "Saving…" : template ? "Save changes" : "Create"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Small affordance reused by the card's empty state. */
export function NewTemplateButton({ onClick }: { onClick: () => void }) {
  return (
    <Button onClick={onClick} size="sm">
      <Plus className="mr-1 h-3.5 w-3.5" />
      New template
    </Button>
  );
}
