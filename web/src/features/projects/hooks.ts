/**
 * Relay-backed data for the projects surface.
 *
 * Two query shapes, and the difference between them is not cosmetic. The relay
 * pushes `kinds`, `authors`, `#e`, `#h` and (for NIP-33-only filters) `#d` into
 * SQL before the `LIMIT`; every other generic tag — `#a` included — is matched
 * *after* it (`filter_fully_pushable` and the `filters_match` post-pass in
 * `crates/buzz-relay/src/handlers/req.rs`). So an `#a`-scoped historical query
 * can come back short while older matching events sit beyond the limited
 * window, and its short page is not an end signal.
 *
 * Everything enumerated here is therefore scoped by a pushed constraint and
 * matched to its repository client-side. Live subscriptions are the opposite
 * case — fan-out applies the whole filter with no limit in play — so those do
 * carry `#a`, which keeps them cheap.
 */

import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useEffect } from "react";

import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import { ownPubkey, signNostrEvent } from "@/shared/lib/nostr-signer";
import { relayHttpBaseUrl } from "@/shared/lib/relay-url";
import {
  GIT_STATUS_KINDS,
  KIND_DELETION,
  KIND_GIT_ISSUE,
  KIND_PROJECT_ANNOUNCEMENT,
  KIND_REPO_ANNOUNCEMENT,
  KIND_TEXT_NOTE,
} from "./lib/kinds.ts";
import type { EventTemplate } from "./lib/projectEvents.ts";
import {
  buildGitIssueTemplate,
  buildInitialProjectTemplates,
  buildIssueCommentTemplate,
  buildIssueStatusTemplate,
} from "./lib/projectEvents.ts";
import type { IssueLifecycle, ProjectIssue } from "./lib/projectIssues.ts";
import {
  nextProjectIssueCommentCreatedAt,
  projectIssueEventsToIssues,
} from "./lib/projectIssues.ts";
import type { Project, Repository } from "./lib/projectModels.ts";
import { buildProjectReadModels } from "./lib/projectModels.ts";
import {
  enumerateWithBestTransport,
  wsQueryPage,
} from "./lib/relayTransport.ts";

export const PROJECTS_QUERY_KEY = ["projects", "collection"] as const;

export type ProjectCollection = {
  projects: Project[];
  /** True when the relay could not be drained — the list is a subset. */
  possiblyIncomplete: boolean;
};

/** `a` tag of an event, lowercased for coordinate comparison. */
function repoAddressOf(event: SignedNostrEvent): string | null {
  return event.tags.find((tag) => tag[0] === "a")?.[1] ?? null;
}

/**
 * Every listed project and every unclaimed repository, folded per NIP-MP.
 *
 * Projects, repositories and the deletions bearing on them are enumerated by
 * `kinds` alone, which is the only shape whose short-page end signal the relay
 * actually honours.
 */
export function useProjectCollection(): {
  data: ProjectCollection | undefined;
  isLoading: boolean;
  error: Error | null;
} {
  const { session, status } = useRelaySession();
  const queryClient = useQueryClient();
  const enabled = status === "open";

  const query = useQuery<ProjectCollection>({
    queryKey: PROJECTS_QUERY_KEY,
    enabled,
    staleTime: 30_000,
    queryFn: async ({ signal }) => {
      const [projectEvents, repositoryEvents, deletionEvents] =
        await Promise.all([
          enumerateWithBestTransport(
            session,
            [KIND_PROJECT_ANNOUNCEMENT],
            undefined,
            signal,
          ),
          enumerateWithBestTransport(
            session,
            [KIND_REPO_ANNOUNCEMENT],
            undefined,
            signal,
          ),
          enumerateWithBestTransport(
            session,
            [KIND_DELETION],
            undefined,
            signal,
          ),
        ]);
      return {
        projects: buildProjectReadModels({
          projectEvents: projectEvents.events,
          repositoryEvents: repositoryEvents.events,
          deletionEvents: deletionEvents.events,
          relayOrigin: relayHttpBaseUrl(),
        }),
        possiblyIncomplete:
          projectEvents.possiblyIncomplete ||
          repositoryEvents.possiblyIncomplete ||
          deletionEvents.possiblyIncomplete,
      };
    },
  });

  // Live refresh. These kinds are global-only at the relay
  // (`is_global_only_kind`, handlers/ingest.rs), so a channel-less
  // subscription reaches them through the global kind index — a `#h` tag here
  // would route the subscription into a channel and it would never fire.
  useEffect(() => {
    if (!enabled) return;
    return session.subscribe(
      {
        kinds: [
          KIND_PROJECT_ANNOUNCEMENT,
          KIND_REPO_ANNOUNCEMENT,
          KIND_DELETION,
        ],
        limit: 1,
      },
      {
        onEvent: () => {
          void queryClient.invalidateQueries({ queryKey: PROJECTS_QUERY_KEY });
        },
      },
    );
  }, [enabled, queryClient, session]);

  return {
    data: query.data,
    isLoading: query.isLoading,
    error: (query.error as Error) ?? null,
  };
}

/** One project by its addressable id, out of the folded collection. */
export function useProject(projectId: string | undefined): {
  project: Project | null;
  isLoading: boolean;
  possiblyIncomplete: boolean;
} {
  const { data, isLoading } = useProjectCollection();
  return {
    project:
      data?.projects.find((candidate) => candidate.id === projectId) ?? null,
    isLoading,
    possiblyIncomplete: data?.possiblyIncomplete ?? false,
  };
}

export function issuesQueryKey(repoAddress: string | undefined) {
  return ["projects", "issues", repoAddress ?? "none"] as const;
}

export type IssueCollection = {
  issues: ProjectIssue[];
  possiblyIncomplete: boolean;
};

/**
 * Issues for one repository, with their statuses and comments.
 *
 * Issues and statuses are enumerated by `kinds` and filtered to the repository
 * here; comments ride an `#e` filter, which the relay does push into SQL.
 */
export function useProjectIssues(repoAddress: string | undefined): {
  data: IssueCollection | undefined;
  isLoading: boolean;
  error: Error | null;
} {
  const { session, status } = useRelaySession();
  const queryClient = useQueryClient();
  const enabled = status === "open" && Boolean(repoAddress);

  const query = useQuery<IssueCollection>({
    queryKey: issuesQueryKey(repoAddress),
    enabled,
    staleTime: 15_000,
    queryFn: async ({ signal }) => {
      const [issuePage, statusPage] = await Promise.all([
        enumerateWithBestTransport(
          session,
          [KIND_GIT_ISSUE],
          undefined,
          signal,
        ),
        enumerateWithBestTransport(
          session,
          [...GIT_STATUS_KINDS],
          undefined,
          signal,
        ),
      ]);
      const issueEvents = issuePage.events.filter(
        (event) => repoAddressOf(event as SignedNostrEvent) === repoAddress,
      );
      const commentEvents = issueEvents.length
        ? await wsQueryPage(session, {
            kinds: [KIND_TEXT_NOTE],
            "#e": issueEvents.map((event) => event.id),
            limit: 500,
          })
        : [];
      return {
        issues: projectIssueEventsToIssues(
          issueEvents,
          statusPage.events,
          commentEvents,
        ),
        possiblyIncomplete:
          issuePage.possiblyIncomplete || statusPage.possiblyIncomplete,
      };
    },
  });

  // Live: fan-out applies the whole filter with no LIMIT in play, so `#a`
  // scoping is exact here even though it is not on the historical page.
  useEffect(() => {
    if (!enabled || !repoAddress) return;
    return session.subscribe(
      {
        kinds: [KIND_GIT_ISSUE, ...GIT_STATUS_KINDS, KIND_TEXT_NOTE],
        "#a": [repoAddress],
        limit: 1,
      },
      {
        onEvent: () => {
          void queryClient.invalidateQueries({
            queryKey: issuesQueryKey(repoAddress),
          });
        },
      },
    );
  }, [enabled, queryClient, repoAddress, session]);

  return {
    data: query.data,
    isLoading: query.isLoading,
    error: (query.error as Error) ?? null,
  };
}

async function publish(
  session: ReturnType<typeof useRelaySession>["session"],
  template: EventTemplate & { created_at?: number },
): Promise<SignedNostrEvent> {
  const event = await signNostrEvent(template);
  const result = await session.publish(event);
  if (!result.ok) {
    throw new Error(result.message || "The relay rejected the event.");
  }
  return event;
}

export type CreateProjectInput = {
  channelId?: string | null;
  cloneUrl?: string;
  description?: string;
  name: string;
  ownerPubkey: string;
  webUrl?: string;
};

/**
 * Publishes the repository announcement first, then the project that lists it.
 *
 * Order matters for what a reader sees in between: a project whose member has
 * not landed yet renders that member as "unavailable", which looks like data
 * loss. A repository with no project yet simply renders as its own card, which
 * is a correct intermediate state.
 */
export function useCreateProject() {
  const { session } = useRelaySession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateProjectInput) => {
      const templates = buildInitialProjectTemplates(input);
      await publish(session, templates.repository);
      await publish(session, templates.project);
      return {
        dtag: templates.dtag,
        projectAddress: `${KIND_PROJECT_ANNOUNCEMENT}:${input.ownerPubkey.toLowerCase()}:${templates.dtag}`,
        repositoryAddress: templates.repositoryAddress,
      };
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: PROJECTS_QUERY_KEY }),
  });
}

export function useCreateIssue(repository: Repository | null | undefined) {
  const { session } = useRelaySession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      body: string;
      labels?: string[];
      title: string;
    }) => {
      if (!repository) throw new Error("No repository selected.");
      const event = await publish(
        session,
        buildGitIssueTemplate({
          body: input.body,
          labels: input.labels,
          repoAddress: repository.repoAddress,
          repoOwner: repository.owner,
          title: input.title,
        }),
      );
      return event.id;
    },
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: issuesQueryKey(repository?.repoAddress),
      }),
  });
}

export function useSetIssueLifecycle(
  repository: Repository | null | undefined,
) {
  const { session } = useRelaySession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      issue: ProjectIssue;
      lifecycle: IssueLifecycle;
    }) => {
      if (!repository) throw new Error("No repository selected.");
      await publish(
        session,
        buildIssueStatusTemplate({
          currentLifecycle: input.issue.lifecycle,
          nextLifecycle: input.lifecycle,
          // The repo owner and the issue author both need to see the move.
          recipients: [repository.owner, input.issue.author],
          repoAddress: repository.repoAddress,
          rootEventId: input.issue.id,
        }),
      );
    },
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: issuesQueryKey(repository?.repoAddress),
      }),
  });
}

export function usePostIssueComment(repository: Repository | null | undefined) {
  const { session } = useRelaySession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { body: string; issue: ProjectIssue }) => {
      if (!repository) throw new Error("No repository selected.");
      const template = buildIssueCommentTemplate({
        body: input.body,
        recipients: [repository.owner, input.issue.author],
        repoAddress: repository.repoAddress,
        rootEventId: input.issue.id,
      });
      // Ordering is per-author, so the timestamp nudge needs to know who is
      // about to sign; an unknown signer just takes the wall clock.
      const author = await ownPubkey();
      const now = Math.floor(Date.now() / 1_000);
      await publish(session, {
        ...template,
        created_at: author
          ? nextProjectIssueCommentCreatedAt(input.issue, now, author)
          : now,
      });
    },
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: issuesQueryKey(repository?.repoAddress),
      }),
  });
}
