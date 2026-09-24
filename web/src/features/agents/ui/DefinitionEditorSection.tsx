import { useState } from "react";
import type { PersonaDefinition } from "../lib/personas";
import { toast } from "sonner";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import type { RelaySession } from "@/shared/api/relay-session";
import {
  ownPubkey,
  signNostrEvent,
  type SignedNostrEvent,
} from "@/shared/lib/nostr-signer";
import {
  agentsSharingDefinition,
  buildPersonaUpdate,
  definitionEditable,
} from "../lib/personaEdit";
import { targetForAgent, type RosterRow } from "../lib/roster";
import { controlsEnabled } from "../lib/adminCommandCapabilities";
import type { DesktopCatalog } from "../lib/desktopCatalog";
import type { useAdminCommands } from "./AgentAdminPanel";
import { ModelProviderFields, SectionHeading } from "./AgentFormSections";

/**
 * Edit a linked agent's kind-30175 definition from the web: republish the
 * owner's latest definition with the edited name / prompt / model /
 * provider (buildPersonaUpdate keeps every other key and tag). Desktop's
 * app-shell persona sync ingests owner-authored 30175s at all times, so this
 * is the same wire path as a desktop edit. Running agents need a restart to
 * pick up the change; desktop auto-restarts idle ones, and this section
 * offers a manual nudge for the rest.
 */
export function DefinitionEditorSection({
  row,
  roster,
  session,
  catalogs,
  admin,
  registryModels,
}: {
  row: RosterRow;
  roster: readonly RosterRow[];
  session: RelaySession;
  catalogs: DesktopCatalog[];
  admin: ReturnType<typeof useAdminCommands>;
  registryModels: string[];
}) {
  const editable = definitionEditable(row);
  const [published, setPublished] = useState<SignedNostrEvent | null>(null);
  if (!editable.ok || !row.persona) {
    return (
      <div className="space-y-2">
        <SectionHeading>Definition</SectionHeading>
        <p className="rounded-md bg-accent/40 px-2 py-1 text-xs text-muted-foreground">
          {editable.ok ? "Definition not found." : editable.reason}
        </p>
      </div>
    );
  }
  return (
    <DefinitionEditor
      persona={row.persona}
      sharingRows={agentsSharingDefinition(roster, row.persona.id)}
      base={definitionBase(row.persona, published)}
      onPublished={setPublished}
      session={session}
      catalogs={catalogs}
      admin={admin}
      registryModels={registryModels}
    />
  );
}

/**
 * The newer of the relay's head and our own last publish, so a second save
 * before the relay echoes still gets a strictly greater created_at. Every
 * definition mutation (edit, share toggle, delete) republishes from this.
 */
export function definitionBase(
  persona: PersonaDefinition,
  published: SignedNostrEvent | null,
): SignedNostrEvent {
  return published && published.created_at >= persona.event.created_at
    ? published
    : persona.event;
}

/**
 * The definition editor proper — shared by the agent config panel (via the
 * adapter above) and the standalone Definitions view. The caller owns the
 * base (see definitionBase) so edits and actions stay monotonic together.
 */
export function DefinitionEditor({
  persona,
  sharingRows: shared,
  base,
  onPublished,
  session,
  catalogs,
  admin,
  registryModels,
}: {
  persona: PersonaDefinition;
  /** Roster rows linked to this definition (restart offer + count). */
  sharingRows: readonly RosterRow[];
  base: SignedNostrEvent;
  onPublished: (event: SignedNostrEvent) => void;
  session: RelaySession;
  catalogs: DesktopCatalog[];
  admin: ReturnType<typeof useAdminCommands>;
  registryModels: string[];
}) {
  const [name, setName] = useState(persona.name);
  const [prompt, setPrompt] = useState(persona.systemPrompt);
  const [model, setModel] = useState(persona.model);
  const [provider, setProvider] = useState(persona.provider);
  const [busy, setBusy] = useState(false);
  const [restartOffer, setRestartOffer] = useState(false);

  const save = async () => {
    if (busy) {
      return;
    }
    const me = await ownPubkey();
    if (me !== base.pubkey) {
      toast.error("Only the definition's owner can edit it.");
      return;
    }
    const built = buildPersonaUpdate(
      base,
      { displayName: name, systemPrompt: prompt, model, provider },
      Math.floor(Date.now() / 1000),
    );
    if ("error" in built) {
      toast.error(built.error);
      return;
    }
    setBusy(true);
    try {
      const signed = await signNostrEvent(built.template);
      const result = await session.publish(signed);
      if (!result.ok) {
        toast.error(result.message || "The relay rejected the definition.");
        return;
      }
      toast.success("Definition saved");
      onPublished(signed);
      setRestartOffer(true);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not save the definition.",
      );
    } finally {
      setBusy(false);
    }
  };

  const restartable = shared.filter((r) =>
    controlsEnabled(catalogs, r.machines),
  );
  const desktopOnly = shared.filter(
    (r) => !controlsEnabled(catalogs, r.machines),
  );
  const restartAll = () => {
    for (const r of restartable) {
      void admin.send(
        { action: "restart", request: { pubkey: r.pubkey } },
        `Restart ${r.name}`,
        targetForAgent(r.machines),
      );
    }
    setRestartOffer(false);
  };

  return (
    <div className="space-y-3">
      <SectionHeading>Definition</SectionHeading>
      <div className="block space-y-1">
        <span className="block text-sm text-muted-foreground">
          Definition name
        </span>
        <Input
          aria-label="Definition name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <label className="block space-y-1">
        <span className="text-sm text-muted-foreground">
          Definition system prompt
        </span>
        <textarea
          aria-label="Definition system prompt"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          rows={5}
          className="w-full resize-y rounded-md border border-input bg-card px-3 py-2 text-sm"
        />
      </label>
      <ModelProviderFields
        model={model}
        onModelChange={setModel}
        provider={provider}
        onProviderChange={setProvider}
        registryModels={registryModels}
        quadDisabled={false}
        harnessId=""
        onHarnessChange={() => {}}
        customCommand=""
        onCustomCommandChange={() => {}}
        customArgs=""
        onCustomArgsChange={() => {}}
        catalogs={catalogs}
        hideHarness
        labelPrefix="Definition "
      />
      {shared.length > 1 && (
        <p className="rounded-md bg-accent/40 px-2 py-1 text-xs text-muted-foreground">
          Applies to {shared.length} agents in your registry:{" "}
          {shared.map((r) => r.name).join(", ")}
        </p>
      )}
      <Button size="sm" disabled={busy} onClick={() => void save()}>
        {busy ? "Saving…" : "Save definition"}
      </Button>
      {restartOffer && (
        <div className="space-y-1">
          {restartable.length > 0 && (
            <Button size="sm" variant="outline" onClick={restartAll}>
              Restart {restartable.length} agent
              {restartable.length === 1 ? "" : "s"} now
            </Button>
          )}
          {desktopOnly.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Restart from desktop: {desktopOnly.map((r) => r.name).join(", ")}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Desktop restarts idle agents automatically when auto-restart is on.
          </p>
        </div>
      )}
    </div>
  );
}
