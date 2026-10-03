import { useId, useState } from "react";
import { Input } from "@/shared/ui/input";
import { accessWarning, type RespondToMode } from "../../../lib/respondToField";
import type { CardFields } from "./cardTypes";

/** Named audience selection with desktop rule 11's warning and placement. */
export function WhoCanInstructCard({
  fields,
  people,
}: {
  fields: CardFields;
  people: readonly { pubkey: string; name: string }[];
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const mode = fields.value("respondTo") as RespondToMode;
  const selected: string[] = JSON.parse(
    String(fields.value("respondToAllowlist")),
  );
  const warning = accessWarning(mode);
  return (
    <section
      className="space-y-3 rounded-xl border border-border bg-card p-4"
      data-testid="who-can-instruct-card"
    >
      <h2 className="text-sm font-semibold">Who can instruct</h2>
      <label className="sr-only" htmlFor={id}>
        Who can instruct
      </label>
      <select
        id={id}
        value={mode}
        disabled={fields.disabled}
        className="min-h-11 w-full rounded-lg border border-input bg-background px-3 text-base md:text-sm"
        onChange={(event) => fields.edit("respondTo", event.target.value)}
      >
        <option value="owner-only">Only me</option>
        <option value="allowlist">Specific people…</option>
        <option value="anyone">Anyone in the channel</option>
        <option value="nobody" disabled>
          Nobody (paused) · needs a desktop update
        </option>
      </select>
      {mode === "allowlist" && (
        <div className="space-y-2" data-testid="instruction-people-picker">
          <Input
            aria-label="Find people by name"
            placeholder="Find people…"
            value={query}
            disabled={fields.disabled}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="max-h-52 overflow-y-auto">
            {people
              .filter(
                (person) =>
                  selected.includes(person.pubkey) ||
                  person.name.toLowerCase().includes(query.toLowerCase()),
              )
              .map((person) => (
                <label
                  key={person.pubkey}
                  className="flex min-h-11 items-center gap-3 text-sm"
                >
                  <input
                    type="checkbox"
                    disabled={fields.disabled}
                    checked={selected.includes(person.pubkey)}
                    onChange={(event) =>
                      fields.edit(
                        "respondToAllowlist",
                        JSON.stringify(
                          event.target.checked
                            ? [...selected, person.pubkey]
                            : selected.filter((pk) => pk !== person.pubkey),
                        ),
                      )
                    }
                  />
                  {person.name}
                </label>
              ))}
          </div>
          {!people.length && (
            <p className="text-xs text-muted-foreground">
              People appear from your channels when their profiles arrive.
            </p>
          )}
        </div>
      )}
      {warning && (
        <p
          className="rounded-lg border border-coral-line bg-coral-wash p-3 text-xs text-coral-ink"
          data-testid="agent-access-warning"
        >
          {warning}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Applies on restart. Nobody (paused) needs a later Buzz Desktop update.
      </p>
    </section>
  );
}
