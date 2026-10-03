import { Plus, X } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { newEnvRowId } from "../../../lib/envRows";
import { buildEnvPatch, type EnvPatchRow } from "./envPatch";

/** No environment read exists yet: expose only deliberate, patch-only writes. */
export function EnvVarsCard({
  rows,
  onChange,
  disabled,
}: {
  rows: EnvPatchRow[];
  onChange: (rows: EnvPatchRow[]) => void;
  disabled: boolean;
}) {
  const result = buildEnvPatch(rows);
  const edit = (id: string, patch: Partial<EnvPatchRow>) =>
    onChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  return (
    <section
      className="space-y-3 rounded-xl border border-border bg-card p-4"
      data-testid="env-vars-card"
    >
      <h2 className="text-sm font-semibold">Environment variables</h2>
      <details className="space-y-3">
        <summary className="min-h-11 cursor-pointer text-sm">
          Set without seeing the current value
        </summary>
        <p className="text-xs text-muted-foreground">
          Current variables are not reported by Buzz Desktop. Set or remove a
          named variable; every other variable stays as it is. Values are sealed
          to your key.
        </p>
        <fieldset disabled={disabled} className="space-y-3">
          {rows.map((row, index) => (
            <div
              key={row.id}
              className="space-y-2 rounded-lg border border-border p-3"
            >
              <div className="flex min-w-0 gap-2">
                <Input
                  aria-label={`Variable ${index + 1} name`}
                  value={row.key}
                  onChange={(event) =>
                    edit(row.id, { key: event.target.value })
                  }
                  placeholder="KEY"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  className="min-h-11 min-w-0 font-mono text-sm"
                />
                <Button
                  variant="ghost"
                  className="min-h-11 min-w-11 shrink-0"
                  aria-label={`Discard variable row ${index + 1}`}
                  onClick={() =>
                    onChange(rows.filter((item) => item.id !== row.id))
                  }
                >
                  <X aria-hidden className="size-4" />
                </Button>
              </div>
              <label className="block space-y-1 text-xs text-muted-foreground">
                Action
                <select
                  aria-label={`Variable ${index + 1} action`}
                  value={row.operation}
                  onChange={(event) =>
                    edit(row.id, {
                      operation: event.target.value as EnvPatchRow["operation"],
                      value: "",
                    })
                  }
                  className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
                >
                  <option value="set">Set or replace</option>
                  <option value="remove">Remove from this agent</option>
                </select>
              </label>
              {row.operation === "set" ? (
                <Input
                  type="password"
                  aria-label={`Variable ${index + 1} value`}
                  value={row.value}
                  onChange={(event) =>
                    edit(row.id, { value: event.target.value })
                  }
                  placeholder="New value"
                  autoComplete="off"
                  className="min-h-11 text-sm"
                />
              ) : (
                <p className="text-xs text-muted-foreground">
                  Removes only this named variable.
                </p>
              )}
            </div>
          ))}
          {"error" in result && (
            <p role="alert" className="text-xs text-coral-ink">
              {result.error}
            </p>
          )}
          <Button
            variant="outline"
            className="min-h-11"
            onClick={() =>
              onChange([
                ...rows,
                { id: newEnvRowId(), key: "", value: "", operation: "set" },
              ])
            }
          >
            <Plus aria-hidden className="mr-1 size-4" />
            Add variable
          </Button>
        </fieldset>
      </details>
    </section>
  );
}
