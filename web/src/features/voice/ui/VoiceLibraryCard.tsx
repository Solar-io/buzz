import { useEffect, useState, useSyncExternalStore } from "react";
import { useAgentRegistry } from "@/features/agents/useAgentRegistry";
import { useProfiles } from "@/features/channels/hooks";
import { useChannels } from "@/features/channels/useChannels";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import {
  useAgentVoiceAssignments,
  useAgentVoiceSelections,
  useBridgeVoices,
  useVoiceLibraryAdmin,
} from "../hooks.ts";
import {
  addVoice,
  listAvailable,
  removeVoice,
} from "../lib/voiceLibraryApi.ts";
import {
  inUseBy,
  localVoiceOverrides,
  type AvailableVoice,
  type LibraryEngine,
  type LibraryVoice,
  type VoiceUsage,
} from "../lib/voiceLibraryModel.ts";
import {
  subscribeVoiceLibrary,
  voiceLibraryVersion,
} from "../lib/voiceLibraryRevision.ts";
import { engineLabel } from "./voicePickerOptions.ts";
import { VoiceLibraryRows } from "./VoiceLibraryRows.tsx";
import { createVoicePreviewer } from "./voicePreview.ts";

/** Shared library management; authority is enforced by the bridge's signed API. */
export function VoiceLibraryCard() {
  const [engine, setEngine] = useState<LibraryEngine>("eleven");
  const library = useBridgeVoices(engine);
  const { isAdmin } = useVoiceLibraryAdmin();
  const assignments = useAgentVoiceAssignments();
  const selections = useAgentVoiceSelections();
  const agents = useAgentRegistry();
  const { channels } = useChannels();
  const pubkeys = [
    ...new Set([...assignments.byAgent.keys(), ...selections.byPubkey.keys()]),
  ];
  const profiles = useProfiles(pubkeys);
  const version = useSyncExternalStore(
    subscribeVoiceLibrary,
    voiceLibraryVersion,
    voiceLibraryVersion,
  );
  const [input, setInput] = useState("");
  const [browse, setBrowse] = useState(false);
  const [query, setQuery] = useState("");
  const [available, setAvailable] = useState<AvailableVoice[]>([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<{
    engine: LibraryEngine;
    voice: LibraryVoice;
    uses: VoiceUsage[];
  } | null>(null);
  const [previewer] = useState(() => createVoicePreviewer());
  useEffect(() => () => previewer.dispose(), [previewer]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: successful edits invalidate the provider rows' inLibrary flags
  useEffect(() => {
    if (!browse) return;
    const controller = new AbortController();
    setSearching(true);
    setAvailable([]);
    const timer = setTimeout(() => {
      void listAvailable(engine, query, controller.signal)
        .then(
          (voices) => {
            if (!controller.signal.aborted) setAvailable(voices);
          },
          (cause: unknown) => {
            if (!controller.signal.aborted)
              setError(
                cause instanceof Error
                  ? cause.message
                  : "Could not browse voices.",
              );
          },
        )
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [browse, engine, query, version]);

  async function add(id: string) {
    if (!isAdmin || busy) return;
    setBusy(true);
    setError(null);
    try {
      await addVoice(engine, id);
      setInput("");
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "Could not add voice.");
    } finally {
      setBusy(false);
    }
  }

  function requestRemoval(voice: LibraryVoice) {
    let storage: Storage | null = null;
    try {
      storage = window.localStorage;
    } catch {
      /* Unavailable storage. */
    }
    setError(null);
    setRemoving({
      engine,
      voice,
      uses: inUseBy(
        `${engine}:${voice.id}`,
        assignments.byAgent.values(),
        selections.byPubkey.values(),
        localVoiceOverrides(storage),
      ),
    });
  }

  async function confirmRemoval() {
    if (!removing || !isAdmin || busy) return;
    setBusy(true);
    setError(null);
    try {
      await removeVoice(removing.engine, removing.voice.id);
      setRemoving(null);
    } catch (cause: unknown) {
      setError(
        cause instanceof Error ? cause.message : "Could not remove voice.",
      );
    } finally {
      setBusy(false);
    }
  }

  function usageLabel(use: VoiceUsage): string {
    if (use.source === "huddle")
      return `${channels.find((room) => room.id === use.channelId)?.name ?? "Room on this device"} (channel override)`;
    const key = use.pubkey?.toLowerCase() ?? "";
    const name =
      agents.find((agent) => agent.pubkey.toLowerCase() === key)?.name ??
      profiles.get(key)?.name ??
      truncatePubkey(key);
    return `${name} (${use.source === "assignment" ? "owner assignment" : "agent's choice"})`;
  }

  const usageReady = assignments.ready && selections.ready;
  return (
    <section
      className="space-y-3 rounded-lg border border-border bg-card p-4"
      data-testid="settings-voice-library"
    >
      <h2 className="font-medium">Voice library</h2>
      <p className="text-xs text-muted-foreground">
        Voices offered to everyone in the community. Removing a voice keeps
        existing assignments speaking until reassigned.
      </p>
      <fieldset className="flex gap-2" aria-label="Library provider">
        {(["eleven", "fish"] as const).map((candidate) => (
          <Button
            key={candidate}
            size="sm"
            variant={engine === candidate ? "secondary" : "ghost"}
            aria-pressed={engine === candidate}
            disabled={busy}
            onClick={() => {
              setEngine(candidate);
              setInput("");
              setQuery("");
              setError(null);
            }}
          >
            {engineLabel(candidate)}
          </Button>
        ))}
      </fieldset>
      {!isAdmin && (
        <p
          className="text-xs text-muted-foreground"
          data-testid="voice-library-readonly"
        >
          Read-only. Only the voice-library admin can add or remove voices.
        </p>
      )}
      {(error || library.error) && (
        <p className="text-sm text-destructive" role="alert">
          {error ?? library.error}
        </p>
      )}
      {!library.ready ? (
        <p className="text-sm text-muted-foreground">Loading voices…</p>
      ) : library.voices.length === 0 && !library.error ? (
        <p className="text-sm text-muted-foreground">
          No voices in this library yet.
        </p>
      ) : null}
      <VoiceLibraryRows
        engine={engine}
        voices={library.voices}
        isAdmin={isAdmin}
        busy={busy || !usageReady}
        onPreview={(key) => previewer.preview({ engine, key })}
        onAdd={(id) => void add(id)}
        onRemove={requestRemoval}
      />
      {isAdmin && (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void add(input);
          }}
        >
          <input
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm"
            aria-label="Voice id or URL"
            placeholder="Voice id or provider URL"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            disabled={busy}
          />
          <Button
            size="sm"
            type="submit"
            variant="secondary"
            disabled={busy || !input.trim()}
          >
            Add voice
          </Button>
        </form>
      )}
      <Button
        size="sm"
        variant="ghost"
        onClick={() => setBrowse((value) => !value)}
        aria-expanded={browse}
      >
        Browse {engineLabel(engine)}
      </Button>
      {browse && (
        <div className="space-y-2 border-t border-border pt-3">
          <p className="text-xs text-muted-foreground">
            {engine === "fish"
              ? "Your models appear below. Search the public Fish Audio library by name."
              : "Voices in your ElevenLabs account. Add other voices to that account first."}
          </p>
          <input
            className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
            type="search"
            aria-label={
              engine === "fish"
                ? "Search public Fish voices"
                : "Search ElevenLabs voices"
            }
            maxLength={64}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setError(null);
            }}
          />
          {searching ? (
            <p className="text-sm text-muted-foreground">
              Loading provider voices…
            </p>
          ) : available.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No provider voices found.
            </p>
          ) : null}
          <VoiceLibraryRows
            engine={engine}
            voices={available}
            browse
            isAdmin={isAdmin}
            busy={busy}
            onPreview={(key) => previewer.preview({ engine, key })}
            onAdd={(id) => void add(id)}
            onRemove={requestRemoval}
          />
        </div>
      )}
      <Dialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setRemoving(null);
        }}
      >
        <DialogContent data-testid="voice-library-remove-confirm">
          <DialogHeader>
            <DialogTitle>Remove {removing?.voice.label}?</DialogTitle>
            <DialogDescription>
              It will disappear from the library. These agents and rooms keep
              their voice until reassigned.
            </DialogDescription>
          </DialogHeader>
          {removing &&
            (removing.uses.length ? (
              <ul
                className="max-h-48 space-y-1 overflow-y-auto text-sm"
                data-testid="voice-library-usage"
              >
                {removing.uses.map((use) => (
                  <li key={`${use.source}:${use.pubkey ?? use.channelId}`}>
                    {usageLabel(use)}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                No assignments or room overrides on this device use this voice.
              </p>
            ))}
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setRemoving(null)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={busy || !isAdmin}
              onClick={() => void confirmRemoval()}
            >
              Remove voice
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
