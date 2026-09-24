import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Input } from "@/shared/ui/input";
import type { ApiKeySelection } from "../lib/providerApiKey";
import { SectionHeading } from "./AgentFormSections";

/**
 * Blind set/clear of the provider's API key on THIS agent instance (the
 * desktop's PersonaProviderApiKeyField label + env-var hint). The value
 * lives only in the edit form's state, rides the sealed admin envVarsPatch,
 * and is never shown back, toasted, logged, or put in a pending label — the
 * web has no read path and the admin ack echoes nothing.
 */
export function ProviderApiKeyField({
  label,
  envVar,
  value,
  onChange,
  linked,
}: {
  label: string;
  envVar: string;
  value: ApiKeySelection;
  onChange: (next: ApiKeySelection) => void;
  linked: boolean;
}) {
  const [reveal, setReveal] = useState(false);
  const typed = value.kind === "set" ? value.value : "";
  return (
    <div className="space-y-3" data-testid="web-provider-api-key">
      <SectionHeading>API key</SectionHeading>
      <p className="text-sm">
        {label}{" "}
        <code className="font-mono text-xs text-muted-foreground">
          {envVar}
        </code>
      </p>
      <fieldset className="flex flex-wrap gap-4 text-sm">
        <label>
          <input
            type="radio"
            name="api-key-mode"
            checked={value.kind === "keep"}
            onChange={() => onChange({ kind: "keep" })}
          />{" "}
          Keep current
        </label>
        <label>
          <input
            type="radio"
            name="api-key-mode"
            checked={value.kind === "set"}
            onChange={() => onChange({ kind: "set", value: typed })}
          />{" "}
          Set new key
        </label>
        <label>
          <input
            type="radio"
            name="api-key-mode"
            checked={value.kind === "clear"}
            onChange={() => onChange({ kind: "clear" })}
          />{" "}
          Remove agent-level key
        </label>
      </fieldset>
      {value.kind === "set" && (
        <div className="flex max-w-md items-center gap-2">
          <Input
            type={reveal ? "text" : "password"}
            autoComplete="off"
            spellCheck={false}
            aria-label={label}
            value={typed}
            onChange={(event) =>
              onChange({ kind: "set", value: event.target.value })
            }
          />
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:bg-accent"
            aria-label={reveal ? "Hide key" : "Show key"}
            onClick={() => setReveal((previous) => !previous)}
          >
            {reveal ? (
              <EyeOff aria-hidden className="h-4 w-4" />
            ) : (
              <Eye aria-hidden className="h-4 w-4" />
            )}
          </button>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        The web can't read the current key — it's never sent back. Leave on Keep
        to change nothing.
        {linked &&
          " Sets the key on this agent only. A key stored on the definition lives in the desktop app."}
      </p>
    </div>
  );
}
