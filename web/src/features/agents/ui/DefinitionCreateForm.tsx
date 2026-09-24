import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/shared/ui/button";
import type { RelaySession } from "@/shared/api/relay-session";
import { uploadBlob } from "@/shared/api/blossom";
import { acceptAvatarDescriptor } from "../lib/avatarUpload";
import { buildPersonaCreate } from "../lib/definitionManage";
import type { DesktopCatalog } from "../lib/desktopCatalog";
import type { RespondToMode } from "../lib/respondToField";
import {
  AccessFields,
  IdentityFields,
  ModelProviderFields,
  RuntimeFields,
  SectionHeading,
} from "./AgentFormSections";
import { mergedCatalogHarnesses, PRESET_HARNESSES } from "./HarnessSelect";
import { publishSigned } from "./publishSigned";

/**
 * Create a standalone kind-30175 definition from the web. Desktop's inbound
 * persona sync inserts it (id = d = a fresh UUID) exactly like a definition
 * created on another of the owner's machines. Definition only — creating an
 * agent FROM it needs a new admin field, so that stays in the desktop app.
 */
export function DefinitionCreateForm({
  session,
  catalogs,
  registryModels,
  onCreated,
  onCancel,
}: {
  session: RelaySession;
  catalogs: DesktopCatalog[];
  registryModels: string[];
  onCreated: (id: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [uploading, setUploading] = useState(false);
  const [runtime, setRuntime] = useState("");
  const [model, setModel] = useState("");
  const [provider, setProvider] = useState("");
  const [respondTo, setRespondTo] = useState<RespondToMode>("owner-only");
  const [allowlist, setAllowlist] = useState<string[]>([]);
  const [parallelism, setParallelism] = useState("");
  const [busy, setBusy] = useState(false);

  const live = mergedCatalogHarnesses(catalogs);
  const harnesses = live.length > 0 ? live : PRESET_HARNESSES;

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const accepted = acceptAvatarDescriptor(await uploadBlob(file));
      if ("error" in accepted) {
        toast.error(accepted.error);
        return;
      }
      setAvatarUrl(accepted.url);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not upload that image.",
      );
    } finally {
      setUploading(false);
    }
  };

  const submit = async () => {
    if (busy) {
      return;
    }
    const parallelismText = parallelism.trim();
    if (parallelismText !== "" && !/^\d+$/.test(parallelismText)) {
      toast.error("Parallelism must be a whole number between 1 and 32.");
      return;
    }
    const id = crypto.randomUUID();
    const built = buildPersonaCreate(
      {
        displayName: name,
        systemPrompt: prompt,
        avatarUrl,
        runtime,
        model,
        provider,
        respondTo,
        respondToAllowlist: allowlist,
        parallelism:
          parallelismText === "" ? null : Number.parseInt(parallelismText, 10),
      },
      id,
      Math.floor(Date.now() / 1000),
    );
    if ("error" in built) {
      toast.error(built.error);
      return;
    }
    setBusy(true);
    const result = await publishSigned(
      session,
      built.template,
      "The relay rejected the definition.",
    );
    setBusy(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success(`Created ${name.trim()}`);
    onCreated(id);
  };

  return (
    <div className="space-y-6">
      <p className="rounded-md bg-accent/40 px-2 py-1 text-xs text-muted-foreground">
        Creates a definition only. Create an agent from it in the desktop app.
      </p>
      <IdentityFields
        name={name}
        onNameChange={setName}
        systemPrompt={prompt}
        onSystemPromptChange={setPrompt}
        avatarUrl={avatarUrl}
        onAvatarUrlChange={setAvatarUrl}
        onAvatarUpload={(file) => void upload(file)}
        avatarUploading={uploading}
      />
      <div className="space-y-3">
        <SectionHeading>Harness</SectionHeading>
        <label className="block space-y-1">
          <span className="text-sm text-muted-foreground">
            Preferred harness (optional)
          </span>
          <select
            aria-label="Definition harness"
            value={runtime}
            onChange={(event) => setRuntime(event.target.value)}
            className="w-full max-w-64 rounded-md border border-input bg-card px-3 py-2 text-sm"
          >
            <option value="">Desktop default</option>
            {harnesses.map((harness) => (
              <option key={harness.id} value={harness.id}>
                {harness.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ModelProviderFields
        model={model}
        onModelChange={setModel}
        provider={provider}
        onProviderChange={setProvider}
        registryModels={registryModels}
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
      <RuntimeFields
        parallelism={parallelism}
        onParallelismChange={setParallelism}
      />
      <AccessFields
        respondTo={respondTo}
        onRespondToChange={setRespondTo}
        allowlist={allowlist}
        onAllowlistChange={setAllowlist}
      />
      <div className="flex gap-2">
        <Button size="sm" disabled={busy} onClick={() => void submit()}>
          {busy ? "Creating…" : "Create definition"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
