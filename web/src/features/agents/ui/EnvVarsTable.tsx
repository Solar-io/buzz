import { Plus, X } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import {
  duplicateKeyRowIds,
  isReservedEnvKey,
  newEnvRowId,
  type EnvRow,
} from "../lib/envRows";

/**
 * KEY/VALUE row editor for agent env vars — the web counterpart of the
 * desktop's EnvVarsEditor, scoped to what the admin protocol can do: the
 * table always starts EMPTY (the web has no env read path), and saving
 * replaces the agent's whole environment. The dirty banner states that
 * consequence in plain language; rows never fabricate current values.
 */
export function EnvVarsTable({
  rows,
  onChange,
  dirty,
  editMode,
  ariaPrefix = "Env",
}: {
  rows: EnvRow[];
  onChange: (next: EnvRow[]) => void;
  /** True once ANY add/edit/remove happened (gates the envVars wire key). */
  dirty: boolean;
  /** Edit mode shows the replace-all warning; create has nothing to replace. */
  editMode: boolean;
  ariaPrefix?: string;
}) {
  const patch = (id: string, field: "key" | "value", next: string) =>
    onChange(
      rows.map((row) => (row.id === id ? { ...row, [field]: next } : row)),
    );
  const remove = (id: string) => onChange(rows.filter((row) => row.id !== id));
  // Earlier rows sharing a key with a later row are discarded at conversion
  // (last row wins) — flagged inline so the semantics are visible pre-save.
  const shadowedIds = duplicateKeyRowIds(rows);

  return (
    <div className="space-y-2">
      {editMode && dirty && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-500">
          Saving replaces the agent's whole environment. Anything you don't
          re-enter is removed — including keys you can't see here.
        </p>
      )}
      {editMode && !dirty && (
        <p className="text-xs text-muted-foreground">
          Current values live on the desktop and aren't visible here. Add a key
          only to set or replace it — saving sends the whole table.
        </p>
      )}
      {rows.length === 0 ? (
        <p className="rounded-md bg-accent/30 px-2 py-1.5 text-xs text-muted-foreground">
          No variables set.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((row) => {
            const reserved = isReservedEnvKey(row.key);
            const duplicate = shadowedIds.has(row.id);
            return (
              <li key={row.id} className="flex items-start gap-1.5">
                <div className="min-w-0 flex-1 space-y-1">
                  <Input
                    aria-label={`${ariaPrefix} key`}
                    value={row.key}
                    onChange={(event) =>
                      patch(row.id, "key", event.target.value)
                    }
                    placeholder="KEY"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    className="font-mono text-xs"
                  />
                  {reserved && (
                    <span className="block rounded bg-red-500/15 px-1.5 py-0.5 text-badge uppercase tracking-wide text-red-400">
                      {row.key.trim() ? "set by Buzz" : "reserved key"}
                    </span>
                  )}
                  {duplicate && (
                    <span className="block text-badge text-amber-500">
                      duplicate — the last row with this key wins
                    </span>
                  )}
                </div>
                <div className="min-w-0 flex-1 space-y-1">
                  <Input
                    aria-label={`${ariaPrefix} value`}
                    value={row.value}
                    onChange={(event) =>
                      patch(row.id, "value", event.target.value)
                    }
                    placeholder="value"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    className="font-mono text-xs"
                  />
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove ${ariaPrefix.toLowerCase()} row`}
                  className="shrink-0"
                  onClick={() => remove(row.id)}
                >
                  <X aria-hidden className="h-4 w-4" />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <Button
        size="sm"
        variant="outline"
        onClick={() =>
          onChange([...rows, { id: newEnvRowId(), key: "", value: "" }])
        }
      >
        <Plus aria-hidden className="mr-1 h-4 w-4" />
        Add variable
      </Button>
    </div>
  );
}
