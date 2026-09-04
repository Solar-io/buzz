import { useMemo, useState } from "react";
import { Search } from "lucide-react";

import { useAgentRegistry } from "@/features/agents/useAgentRegistry";
import { useProfiles, usePresence } from "@/features/channels/hooks";
import type { PresenceStatus } from "@/features/channels/lib/presence.ts";
import { Input } from "@/shared/ui/input";
import { Skeleton } from "@/shared/ui/skeleton";

import {
  useContactPubkeys,
  usePublishNote,
  usePulseNotes,
  usePulseReactions,
  useToggleUpvote,
} from "../hooks.ts";
import { groupAgentNotes } from "../lib/groupAgentNotes.ts";
import { filterNotes } from "../lib/searchNotes.ts";
import type { PulseTab } from "../lib/pulseTypes.ts";
import {
  AgentActivityCard,
  type AgentActivityStatus,
} from "./AgentActivityCard.tsx";
import { NoteCard } from "./NoteCard.tsx";
import { PulseComposer } from "./PulseComposer.tsx";
import { PulseTabBar, pulsePanelId, pulseTabId } from "./PulseTabBar.tsx";

/**
 * Presence → the card's three-state dot.
 *
 * `usePresence` has a fourth state, `unknown`, which the card deliberately
 * does not: an agent whose presence has not been observed is drawn as offline
 * rather than as a distinct "who knows" dot nobody can read. Ephemeral
 * kind:20001 has no history, so on a freshly opened tab that is most of them.
 */
function agentActivityStatus(
  status: PresenceStatus | undefined,
): AgentActivityStatus {
  return status === "online" || status === "away" ? status : "offline";
}

function EmptyState({ message }: { message: string }) {
  return (
    <p
      className="rounded-2xl border border-dashed border-border/60 px-4 py-12 text-center text-sm text-muted-foreground"
      data-testid="pulse-empty"
    >
      {message}
    </p>
  );
}

function FeedSkeleton() {
  return (
    <div className="space-y-5" data-testid="pulse-loading">
      {[0, 1, 2, 3].map((row) => (
        <div className="flex gap-3 py-2" key={row}>
          <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3.5 w-32" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Pulse: the workspace-wide note feed.
 *
 * Six tabs over four relay reads — global `kind:1`, `kind:1` by a set of
 * authors (contacts for Following, the kind:30177 registry for Agents), the
 * viewer's own `kind:7` likes resolved to their targets, and the viewer's own
 * notes. Upvotes are `kind:7`/`kind:5` and fold in a fifth read.
 *
 * The Agents tab is the one that is not just a filtered feed: consecutive
 * notes from one agent inside a five-minute window collapse into a single
 * {@link AgentActivityCard}, so a chatty agent is one row rather than ten.
 */
export function PulseView({ selfPubkey }: { selfPubkey: string | null }) {
  const [activeTab, setActiveTab] = useState<PulseTab>("everyone");
  const [searchQuery, setSearchQuery] = useState("");

  const contactsQuery = useContactPubkeys(selfPubkey);
  const contactPubkeys = useMemo(
    () => contactsQuery.data ?? [],
    [contactsQuery.data],
  );

  const agents = useAgentRegistry();
  const agentPubkeys = useMemo(
    () => agents.map((agent) => agent.pubkey),
    [agents],
  );
  const agentPubkeySet = useMemo(() => new Set(agentPubkeys), [agentPubkeys]);
  const agentPresence = usePresence(agentPubkeys);

  const { notes, isLoading, globalNotes } = usePulseNotes({
    tab: activeTab,
    selfPubkey,
    contactPubkeys,
    agentPubkeys,
  });

  const authorPubkeys = useMemo(() => {
    const set = new Set<string>();
    for (const note of notes) {
      set.add(note.pubkey);
    }
    if (selfPubkey) {
      set.add(selfPubkey);
    }
    return [...set];
  }, [notes, selfPubkey]);
  const profiles = useProfiles(authorPubkeys);

  const authorNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const [pubkey, profile] of profiles) {
      names.set(pubkey, profile.displayName || profile.name || "");
    }
    return names;
  }, [profiles]);

  // The Search tab filters the loaded global feed rather than querying the
  // relay — see `filterNotes` for why, and for the limit that implies.
  const visibleNotes = useMemo(
    () =>
      activeTab === "search"
        ? filterNotes(globalNotes, searchQuery, authorNames)
        : notes,
    [activeTab, authorNames, globalNotes, notes, searchQuery],
  );

  const noteIds = useMemo(
    () => visibleNotes.map((note) => note.id),
    [visibleNotes],
  );
  const reactionsQuery = usePulseReactions(noteIds, selfPubkey);
  const toggleUpvote = useToggleUpvote(noteIds, selfPubkey);
  const publish = usePublishNote(selfPubkey);

  const agentGroups = useMemo(
    () => (activeTab === "agents" ? groupAgentNotes(visibleNotes) : []),
    [activeTab, visibleNotes],
  );

  const emptyMessage: Record<PulseTab, string> = {
    search: searchQuery.trim()
      ? "No loaded notes match that search."
      : "Type to search the notes already loaded in Everyone.",
    everyone: "No public notes yet.",
    people:
      contactPubkeys.length === 0
        ? "You are not following anyone yet."
        : "No notes from the people you follow yet.",
    liked: "No likes yet — tap the heart on a note to save it here.",
    agents:
      agentPubkeys.length === 0
        ? "No agents registered yet."
        : "No agent notes yet. Agents appear here when they publish.",
    mine: "You have not posted any notes yet.",
  };

  const renderFeed = () => {
    if (isLoading) {
      return <FeedSkeleton />;
    }
    if (activeTab === "agents") {
      return agentGroups.length === 0 ? (
        <EmptyState message={emptyMessage.agents} />
      ) : (
        <div>
          {agentGroups.map((group) => (
            <AgentActivityCard
              group={group}
              key={`${group.pubkey}-${group.latestAt}`}
              profile={profiles.get(group.pubkey)}
              status={agentActivityStatus(
                agentPresence.get(group.pubkey)?.status,
              )}
            />
          ))}
        </div>
      );
    }
    return visibleNotes.length === 0 ? (
      <EmptyState message={emptyMessage[activeTab]} />
    ) : (
      <div>
        {visibleNotes.map((note) => (
          <NoteCard
            actions={{
              onToggleUpvote: (noteId, upvote) =>
                toggleUpvote.mutate({ noteId, upvote }),
              onReply: async (noteId, content) => {
                await publish.mutateAsync({ content, replyTo: noteId });
              },
            }}
            isAgent={agentPubkeySet.has(note.pubkey)}
            isSelf={note.pubkey === selfPubkey}
            key={note.id}
            note={note}
            profile={profiles.get(note.pubkey)}
            reaction={reactionsQuery.data?.get(note.id)}
            upvotePending={
              toggleUpvote.isPending &&
              toggleUpvote.variables?.noteId === note.id
            }
          />
        ))}
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="pulse-view">
      <PulseTabBar
        activeTab={activeTab}
        agentCount={agentPubkeys.length}
        onTabChange={setActiveTab}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div
          aria-labelledby={pulseTabId(activeTab)}
          className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-4"
          id={pulsePanelId(activeTab)}
          role="tabpanel"
        >
          {activeTab === "search" ? (
            <div className="relative">
              <Search
                aria-hidden
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                aria-label="Search Pulse notes"
                autoFocus
                className="pl-9"
                data-testid="pulse-search-input"
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search loaded notes by text or author"
                type="search"
                value={searchQuery}
              />
            </div>
          ) : activeTab === "agents" ? null : (
            <PulseComposer
              onPublish={(content) => publish.mutateAsync({ content })}
              profile={selfPubkey ? profiles.get(selfPubkey) : undefined}
              selfPubkey={selfPubkey}
            />
          )}
          {renderFeed()}
        </div>
      </div>
    </div>
  );
}
