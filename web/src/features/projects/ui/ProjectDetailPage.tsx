/**
 * One project: its member repositories, the issues filed against the selected
 * member, and the conversation bound to it.
 *
 * The repository selector is not a nicety. NIP-MP's "Route resolution" is
 * explicit that every repository-scoped operation — issues included — must
 * take an explicit repository coordinate, because a two-repository project
 * that infers its target will silently act on the wrong member. So the
 * selected repository is state here and is passed down, never derived inside
 * the panels.
 */

import { ArrowLeft, GitBranch, Link2, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";

import { useProfiles } from "@/features/channels/hooks";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { relativeTime } from "@/shared/lib/relative-time";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import type { Project, Repository } from "../lib/projectModels.ts";
import { selectProjectRepository } from "../lib/projectModels.ts";
import { lookupTrackerEntry } from "../lib/trackerClient.ts";
import { useTrackerIndex } from "../hooks.ts";
import { IssuesPanel } from "./IssuesPanel.tsx";
import { ProjectConversationPanel } from "./ProjectConversationPanel.tsx";

function RepositoryPicker({
  onSelect,
  repositories,
  selected,
}: {
  onSelect: (repository: Repository) => void;
  repositories: Repository[];
  selected: Repository | null;
}) {
  if (repositories.length <= 1) return null;
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="repository-picker">
      {repositories.map((repository) => (
        <Button
          data-testid={`repository-pick-${repository.dtag}`}
          key={repository.repoAddress}
          onClick={() => onSelect(repository)}
          size="sm"
          type="button"
          variant={
            selected?.repoAddress === repository.repoAddress
              ? "secondary"
              : "ghost"
          }
        >
          <GitBranch />
          {repository.name}
        </Button>
      ))}
    </div>
  );
}

function UnavailableMembers({ addresses }: { addresses: string[] }) {
  if (addresses.length === 0) return null;
  return (
    <div
      className="flex flex-col gap-1 rounded-lg border border-warning/40 bg-warning-bg px-3 py-2"
      data-testid="unavailable-members"
    >
      <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
        <TriangleAlert className="h-3.5 w-3.5 text-warning" />
        {addresses.length === 1
          ? "1 member could not be resolved"
          : `${addresses.length} members could not be resolved`}
      </span>
      {/* Listed rather than dropped: silence would make the project look
          smaller than its author declared it to be. */}
      <ul className="flex flex-col gap-0.5">
        {addresses.map((address) => (
          <li
            className="truncate font-mono text-2xs text-muted-foreground"
            key={address}
          >
            {address}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Open work items from the tracker sidecar. Renders only when the sidecar
 * knows the project — a project the ledger has never mentioned keeps its
 * pre-tracker shape, and a dead sidecar removes the section rather than the
 * page.
 */
function TrackerPanel({
  entry,
}: {
  entry: ReturnType<typeof lookupTrackerEntry>;
}) {
  if (!entry) return null;
  const generatedEpoch = entry.generated
    ? Date.parse(entry.generated) / 1_000
    : Number.NaN;
  return (
    <section
      className="flex flex-col gap-2 rounded-xl border border-border/60 bg-card p-4"
      data-testid="project-tracker"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-foreground">Tracker</h2>
        <span className="text-2xs text-muted-foreground">
          Primary: {entry.owner || "unassigned"}
          {Number.isFinite(generatedEpoch)
            ? ` · generated ${relativeTime(generatedEpoch)}`
            : null}
        </span>
      </div>
      {entry.openItems.length === 0 ? (
        <p className="text-sm text-muted-foreground">No open items.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {entry.openItems.map((item) => (
            <li
              className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm"
              data-testid={`tracker-item-${item.id}`}
              key={item.id}
            >
              <span className="font-mono text-2xs text-muted-foreground">
                {item.id}
              </span>
              <Badge variant="outline">{item.kind}</Badge>
              <span className="text-2xs text-muted-foreground">
                {item.status}
              </span>
              <span className="text-foreground">{item.summary}</span>
              {item.owner ? (
                <span className="text-2xs text-muted-foreground">
                  · {item.owner}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function ProjectDetailPage({
  onBack,
  project,
  viewerPubkey,
}: {
  onBack: () => void;
  project: Project;
  viewerPubkey: string | null;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const repository = selectProjectRepository(project, selectedId);
  const profiles = useProfiles(useMemo(() => [project.owner], [project.owner]));
  const ownerLabel =
    profiles.get(project.owner)?.displayName ?? truncatePubkey(project.owner);
  const trackerIndex = useTrackerIndex([project]);
  const trackerEntry = lookupTrackerEntry(trackerIndex, project);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-6">
      <Button
        className="self-start"
        data-testid="project-back"
        onClick={onBack}
        size="sm"
        type="button"
        variant="ghost"
      >
        <ArrowLeft />
        Projects
      </Button>

      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1
            className="text-xl font-semibold text-foreground"
            data-testid="project-detail-name"
          >
            {project.name}
          </h1>
          {project.implicit ? (
            <Badge variant="outline">Repository</Badge>
          ) : (
            <Badge variant="secondary">Project</Badge>
          )}
        </div>
        {project.description ? (
          <p className="text-sm text-muted-foreground">{project.description}</p>
        ) : null}
        <p className="text-2xs text-muted-foreground">
          {/* The announcer's identity says who published the pointer, not who
              answers for the work — the sidecar is the only place that fact
              lives. */}
          {trackerEntry
            ? `Primary: ${trackerEntry.owner || "unassigned"}`
            : ownerLabel}{" "}
          · created {relativeTime(project.createdAt)} ·{" "}
          <span className="font-mono">{project.dtag}</span>
        </p>
      </header>

      <UnavailableMembers addresses={project.unavailableRepositoryAddresses} />

      <TrackerPanel entry={trackerEntry} />

      <RepositoryPicker
        onSelect={(next) => setSelectedId(next.id)}
        repositories={project.repositories}
        selected={repository}
      />

      {repository ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <GitBranch className="h-3.5 w-3.5" />
            {repository.defaultBranch}
          </span>
          {repository.cloneUrls.map((url) => (
            <span className="flex items-center gap-1 font-mono" key={url}>
              <Link2 className="h-3.5 w-3.5" />
              {url}
            </span>
          ))}
        </div>
      ) : null}

      <Tabs defaultValue="issues">
        <TabsList>
          <TabsTrigger data-testid="tab-issues" value="issues">
            Issues
          </TabsTrigger>
          <TabsTrigger data-testid="tab-conversation" value="conversation">
            Conversation
          </TabsTrigger>
        </TabsList>
        <TabsContent className="pt-3" value="issues">
          <IssuesPanel repository={repository} viewerPubkey={viewerPubkey} />
        </TabsContent>
        <TabsContent className="pt-3" value="conversation">
          <ProjectConversationPanel
            channelId={
              project.projectChannelId ?? repository?.channelId ?? null
            }
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
