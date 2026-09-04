import { useMemo } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";

import { useRelaySession } from "@/shared/api/RelaySessionProvider";

import {
  fetchContactPubkeys,
  fetchGlobalNotes,
  fetchLikedNotes,
  fetchNotesByAuthors,
  fetchOwnNotes,
  fetchReactionState,
  publishNote,
  removeUpvote,
  upvoteNote,
} from "./lib/noteService.ts";
import {
  applyReactionState,
  isDuplicateReactionError,
} from "./lib/noteReactions.ts";
import type {
  PulseNote,
  PulseReactionState,
  PulseTab,
} from "./lib/pulseTypes.ts";

/**
 * Focused poll cadence, matching the desktop's Pulse queries
 * (`PULSE_NOTES_REFETCH_INTERVAL_MS`). Notes are a slow feed; a tighter
 * interval buys nothing and multiplies REQs across six tabs.
 */
export const PULSE_NOTES_REFETCH_MS = 30_000;
/** Reactions move slower still. */
export const PULSE_REACTIONS_REFETCH_MS = 60_000;

/**
 * Suppress the focus refetch: these queries already poll on an interval, so a
 * focus refetch is duplicate work on every tab switch.
 */
const pulseQueryPolicy = {
  staleTime: 5 * 60_000,
  gcTime: 5 * 60_000,
  refetchOnWindowFocus: false,
} as const;

export const pulseQueryKeys = {
  global: ["pulse", "global"] as QueryKey,
  authors: (authors: readonly string[]) =>
    ["pulse", "authors", [...authors].sort().join(",")] as QueryKey,
  liked: (pubkey: string) => ["pulse", "liked", pubkey] as QueryKey,
  mine: (pubkey: string) => ["pulse", "mine", pubkey] as QueryKey,
  contacts: (pubkey: string) => ["pulse", "contacts", pubkey] as QueryKey,
  /** Keyed by a sorted join so a rebuilt-but-identical id array reuses it. */
  reactions: (noteIdsKey: string) =>
    ["pulse", "reactions", noteIdsKey] as QueryKey,
};

/** The viewer's NIP-02 follow set, for the Following tab. */
export function useContactPubkeys(selfPubkey: string | null) {
  const { session, status } = useRelaySession();
  return useQuery<string[]>({
    ...pulseQueryPolicy,
    enabled: status === "open" && !!selfPubkey,
    queryKey: pulseQueryKeys.contacts(selfPubkey ?? ""),
    queryFn: () => fetchContactPubkeys(session, selfPubkey as string),
  });
}

/**
 * The notes for one tab.
 *
 * Only the ACTIVE tab is enabled, so switching tabs opens exactly one REQ set
 * rather than keeping six feeds live. `search` reads the global feed — it
 * filters what is loaded rather than querying the relay (see
 * {@link filterNotes}).
 */
export function usePulseNotes(options: {
  tab: PulseTab;
  selfPubkey: string | null;
  contactPubkeys: readonly string[];
  agentPubkeys: readonly string[];
}) {
  const { tab, selfPubkey, contactPubkeys, agentPubkeys } = options;
  const { session, status } = useRelaySession();
  const ready = status === "open";

  const global = useQuery<PulseNote[]>({
    ...pulseQueryPolicy,
    enabled: ready && (tab === "everyone" || tab === "search"),
    queryKey: pulseQueryKeys.global,
    queryFn: () => fetchGlobalNotes(session),
    refetchInterval: PULSE_NOTES_REFETCH_MS,
  });

  const following = useQuery<PulseNote[]>({
    ...pulseQueryPolicy,
    enabled: ready && tab === "people" && contactPubkeys.length > 0,
    queryKey: pulseQueryKeys.authors(contactPubkeys),
    queryFn: () => fetchNotesByAuthors(session, contactPubkeys),
    refetchInterval: PULSE_NOTES_REFETCH_MS,
  });

  const agents = useQuery<PulseNote[]>({
    ...pulseQueryPolicy,
    enabled: ready && tab === "agents" && agentPubkeys.length > 0,
    queryKey: pulseQueryKeys.authors(agentPubkeys),
    queryFn: () => fetchNotesByAuthors(session, agentPubkeys),
    refetchInterval: PULSE_NOTES_REFETCH_MS,
  });

  const liked = useQuery<PulseNote[]>({
    ...pulseQueryPolicy,
    enabled: ready && tab === "liked" && !!selfPubkey,
    queryKey: pulseQueryKeys.liked(selfPubkey ?? ""),
    queryFn: () => fetchLikedNotes(session, selfPubkey as string),
    refetchInterval: PULSE_NOTES_REFETCH_MS,
  });

  const mine = useQuery<PulseNote[]>({
    ...pulseQueryPolicy,
    enabled: ready && tab === "mine" && !!selfPubkey,
    queryKey: pulseQueryKeys.mine(selfPubkey ?? ""),
    queryFn: () => fetchOwnNotes(session, selfPubkey as string),
    refetchInterval: PULSE_NOTES_REFETCH_MS,
  });

  const active =
    tab === "people"
      ? following
      : tab === "agents"
        ? agents
        : tab === "liked"
          ? liked
          : tab === "mine"
            ? mine
            : global;

  return {
    notes: active.data ?? [],
    isLoading: active.isLoading && active.fetchStatus !== "idle",
    error: active.error,
    /** The global feed, always — the Search tab filters this. */
    globalNotes: global.data ?? [],
  };
}

/** Folded `+` upvote state for the notes currently rendered. */
export function usePulseReactions(
  noteIds: readonly string[],
  selfPubkey: string | null,
) {
  const { session, status } = useRelaySession();
  // A sorted join, not the array itself: a re-render that rebuilds the same
  // ids must not mint a new key and refetch.
  const idsKey = [...noteIds].sort().join(",");
  const key = useMemo(() => pulseQueryKeys.reactions(idsKey), [idsKey]);
  return useQuery<Map<string, PulseReactionState>>({
    ...pulseQueryPolicy,
    enabled: status === "open" && noteIds.length > 0,
    queryKey: key,
    queryFn: () => fetchReactionState(session, noteIds, selfPubkey),
    refetchInterval: PULSE_REACTIONS_REFETCH_MS,
  });
}

/** Publish a note, invalidating the feeds it should appear in. */
export function usePublishNote(selfPubkey: string | null) {
  const { session } = useRelaySession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      content: string;
      replyTo?: string | null;
      mentionPubkeys?: readonly string[];
    }) => {
      const result = await publishNote(session, input);
      if (!result.ok) {
        throw new Error(result.message || "The relay rejected the note.");
      }
      return result;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: pulseQueryKeys.global });
      if (selfPubkey) {
        void queryClient.invalidateQueries({
          queryKey: pulseQueryKeys.mine(selfPubkey),
        });
      }
    },
  });
}

/**
 * Toggle the viewer's `+` upvote on a note.
 *
 * The cache is updated optimistically so the heart responds on the click
 * rather than a relay round-trip later, and rolled back on a genuine failure.
 * A "duplicate: reaction already exists" rejection is NOT a failure — the
 * desired end state already holds — so it keeps the optimistic value.
 */
export function useToggleUpvote(
  noteIds: readonly string[],
  selfPubkey: string | null,
) {
  const { session } = useRelaySession();
  const queryClient = useQueryClient();
  const idsKey = [...noteIds].sort().join(",");
  const key = useMemo(() => pulseQueryKeys.reactions(idsKey), [idsKey]);

  return useMutation({
    mutationFn: async (input: { noteId: string; upvote: boolean }) => {
      if (!selfPubkey) {
        throw new Error("Sign in to like a note.");
      }
      const result = input.upvote
        ? await upvoteNote(session, input.noteId)
        : await removeUpvote(session, input.noteId, selfPubkey);
      if (!result.ok && !isDuplicateReactionError(result.message)) {
        throw new Error(result.message || "The relay rejected the reaction.");
      }
      return result;
    },
    onMutate: (input) => {
      const previous =
        queryClient.getQueryData<Map<string, PulseReactionState>>(key);
      queryClient.setQueryData(
        key,
        applyReactionState(previous, input.noteId, input.upvote),
      );
      return { previous };
    },
    onError: (error, _input, context) => {
      if (isDuplicateReactionError(error)) {
        return;
      }
      if (context?.previous) {
        queryClient.setQueryData(key, context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });
}
