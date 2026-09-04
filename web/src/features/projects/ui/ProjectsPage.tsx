/**
 * The project list — step 2 and step 5 of the NIP-MP fold on screen.
 *
 * A card is either a container (a kind:30621 project, possibly holding several
 * repositories) or an implicit single-repository card for a repository no
 * authorized project claims. Both are rendered the same way on purpose: to a
 * reader they are both "a thing you can open", and the distinction only
 * matters when you look at what is inside.
 */

import { FolderGit2, Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";

import { useProfiles } from "@/features/channels/hooks";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { relativeTime } from "@/shared/lib/relative-time";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Skeleton } from "@/shared/ui/skeleton";
import { useProjectCollection } from "../hooks.ts";
import type { Project } from "../lib/projectModels.ts";
import { CreateProjectDialog } from "./CreateProjectDialog.tsx";
import { IncompleteCollectionNotice } from "./projectPresentation.tsx";

function ProjectCard({
  authorLabel,
  onOpen,
  project,
}: {
  authorLabel: string;
  onOpen: (project: Project) => void;
  project: Project;
}) {
  const memberCount = project.repositories.length;
  const missingCount = project.unavailableRepositoryAddresses.length;
  return (
    <button
      className="flex w-full flex-col gap-2 rounded-xl border border-border/60 bg-card p-4 text-left transition-colors hover:border-border hover:bg-muted/40"
      data-testid={`project-card-${project.dtag}`}
      onClick={() => onOpen(project)}
      type="button"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <FolderGit2 className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-base font-semibold text-foreground">
            {project.name}
          </span>
        </div>
        {project.implicit ? (
          <Badge variant="outline">Repository</Badge>
        ) : (
          <Badge variant="secondary">
            {memberCount === 1 ? "1 repo" : `${memberCount} repos`}
          </Badge>
        )}
      </div>

      {project.description ? (
        <p className="line-clamp-2 text-sm text-muted-foreground">
          {project.description}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground">
        <span>{authorLabel}</span>
        <span>{relativeTime(project.createdAt)}</span>
        {missingCount > 0 ? (
          <span className="text-warning">
            {missingCount === 1
              ? "1 member unavailable"
              : `${missingCount} members unavailable`}
          </span>
        ) : null}
      </div>
    </button>
  );
}

export function ProjectsPage({
  onOpenProject,
  ownerPubkey,
}: {
  onOpenProject: (project: Project) => void;
  ownerPubkey: string | null;
}) {
  const { data, isLoading, error } = useProjectCollection();
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);

  const projects = data?.projects ?? [];
  const owners = useMemo(
    () => [...new Set(projects.map((project) => project.owner))],
    [projects],
  );
  const profiles = useProfiles(owners);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return projects;
    return projects.filter(
      (project) =>
        project.name.toLowerCase().includes(needle) ||
        project.dtag.toLowerCase().includes(needle) ||
        project.description.toLowerCase().includes(needle),
    );
  }, [projects, search]);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Projects</h1>
          <p className="text-sm text-muted-foreground">
            Repositories and the groupings that span them.
          </p>
        </div>
        <Button
          data-testid="new-project"
          disabled={!ownerPubkey}
          onClick={() => setCreating(true)}
          type="button"
        >
          <Plus />
          New project
        </Button>
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="pl-9"
          data-testid="project-search"
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search projects"
          value={search}
        />
      </div>

      {data?.possiblyIncomplete ? (
        <IncompleteCollectionNotice what="projects" />
      ) : null}

      {error ? (
        <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-foreground">
          {error.message}
        </p>
      ) : null}

      {isLoading ? (
        <div className="flex flex-col gap-3" data-testid="projects-loading">
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="h-24 w-full rounded-xl" />
        </div>
      ) : filtered.length === 0 ? (
        <div
          className="rounded-xl border border-dashed border-border/70 px-6 py-12 text-center"
          data-testid="projects-empty"
        >
          <FolderGit2 className="mx-auto h-8 w-8 text-muted-foreground" />
          <h2 className="mt-3 text-base font-semibold text-foreground">
            {projects.length === 0 ? "No projects yet" : "No matching projects"}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {projects.length === 0
              ? "Create one to group the repositories you work in."
              : "Try a different search term."}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3" data-testid="project-list">
          {filtered.map((project) => (
            <ProjectCard
              authorLabel={
                profiles.get(project.owner)?.displayName ??
                truncatePubkey(project.owner)
              }
              key={project.id}
              onOpen={onOpenProject}
              project={project}
            />
          ))}
        </div>
      )}

      <CreateProjectDialog
        onOpenChange={setCreating}
        open={creating}
        ownerPubkey={ownerPubkey}
      />
    </div>
  );
}
