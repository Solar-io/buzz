import { useMemo, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";
import { parsePubkeyInput } from "@/features/dms/lib/dmInput.ts";
import {
  buildDmSuggestions,
  profileLabel,
  resolveSuggestionQuery,
} from "@/features/dms/lib/dmPicker.ts";
import { useProfiles } from "../../hooks.ts";
import type { PeopleRole } from "../../lib/channelMemberAdmin.ts";

/** Reuses the member dialog's name/key search; each invitee has their own role. */
export function AddPeoplePicker({
  candidates,
  memberPubkeys,
  agentPubkeys,
  selfPubkey,
  canAssignRoles,
  locked,
  onClose,
  onAdd,
}: {
  candidates: string[];
  memberPubkeys: string[];
  agentPubkeys: ReadonlySet<string>;
  selfPubkey: string | null;
  canAssignRoles: boolean;
  locked: boolean;
  onClose: () => void;
  onAdd: (pubkey: string, role: PeopleRole) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<
    { pubkey: string; role: PeopleRole }[]
  >([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const profiles = useProfiles([
    ...candidates,
    ...selected.map((person) => person.pubkey),
  ]);
  const filtered = useMemo(
    () =>
      buildDmSuggestions({
        agents: [],
        contacts: candidates.filter(
          (pk) => !memberPubkeys.includes(pk) && !agentPubkeys.has(pk),
        ),
        profiles,
        selfPubkey,
        filter: query,
      }),
    [candidates, memberPubkeys, agentPubkeys, profiles, selfPubkey, query],
  );
  const add = (pubkey: string) => {
    if (memberPubkeys.includes(pubkey) || pubkey === selfPubkey) {
      setError("They are already in this channel.");
      return;
    }
    if (agentPubkeys.has(pubkey)) {
      setError("Use the agent picker to add an agent.");
      return;
    }
    setSelected((people) =>
      people.some((person) => person.pubkey === pubkey)
        ? people
        : [...people, { pubkey, role: "member" }],
    );
    setQuery("");
    setError(null);
  };
  const fromEntry = () => {
    const parsed = parsePubkeyInput(query.trim());
    if (parsed.ok) {
      add(parsed.pubkey);
      return;
    }
    const found =
      parsed.reason !== "wrong-type" &&
      resolveSuggestionQuery(query.trim(), filtered);
    if (found) add(found.pubkey);
    else
      setError(
        parsed.reason === "wrong-type"
          ? parsed.error
          : "Pick a person below, or paste their npub / 64-hex public key.",
      );
  };
  const submit = async () => {
    if (busy || locked || !selected.length) return;
    setBusy(true);
    setError(null);
    const failures: string[] = [];
    for (const person of selected) {
      try {
        await onAdd(person.pubkey, canAssignRoles ? person.role : "member");
        setSelected((people) =>
          people.filter((item) => item.pubkey !== person.pubkey),
        );
      } catch (issue) {
        failures.push(
          `${profileLabel(person.pubkey, profiles)}: ${issue instanceof Error ? issue.message : "Could not add this person."}`,
        );
      }
    }
    setBusy(false);
    if (failures.length) setError(failures.join("\n"));
    else onClose();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        className="max-h-[90dvh] max-w-md overflow-y-auto"
        showCloseButton={!busy}
      >
        <DialogHeader>
          <DialogTitle>Add people</DialogTitle>
          <DialogDescription>
            Find someone in the community, or paste their public key.
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 gap-2">
          <Input
            aria-label="Add person by name or public key"
            className="min-h-11 min-w-0"
            value={query}
            disabled={busy || locked}
            onChange={(event) => {
              setQuery(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                fromEntry();
              }
            }}
            placeholder="Name or public key"
          />
          <Button
            variant="secondary"
            className="min-h-11"
            disabled={busy || locked || !query.trim()}
            onClick={fromEntry}
          >
            Select
          </Button>
        </div>
        {selected.length > 0 && (
          <ul aria-label="Selected people" className="space-y-1">
            {selected.map((person) => {
              const label = profileLabel(person.pubkey, profiles);
              return (
                <li
                  key={person.pubkey}
                  className="flex min-w-0 items-center gap-2 rounded-lg bg-muted px-2"
                >
                  <span
                    className="min-w-0 flex-1 truncate text-sm"
                    title={label}
                  >
                    {label}
                  </span>
                  {canAssignRoles && (
                    <select
                      aria-label={`Invite role for ${label}`}
                      className="min-h-11 w-24 shrink-0 rounded-lg border border-border bg-card px-2 text-sm"
                      value={person.role}
                      disabled={busy || locked}
                      onChange={(event) =>
                        setSelected((people) =>
                          people.map((item) =>
                            item.pubkey === person.pubkey
                              ? {
                                  ...item,
                                  role: event.target.value as PeopleRole,
                                }
                              : item,
                          ),
                        )
                      }
                    >
                      <option value="member">Member</option>
                      <option value="guest">Guest</option>
                      <option value="admin">Admin</option>
                    </select>
                  )}
                  <button
                    type="button"
                    aria-label={`Deselect ${label}`}
                    className="flex size-11 shrink-0 items-center justify-center"
                    disabled={busy || locked}
                    onClick={() =>
                      setSelected((people) =>
                        people.filter((item) => item.pubkey !== person.pubkey),
                      )
                    }
                  >
                    <X aria-hidden className="size-4" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <ul
          className="max-h-52 overflow-y-auto"
          aria-label="People suggestions"
        >
          {filtered
            .filter(
              (person) =>
                !selected.some((item) => item.pubkey === person.pubkey),
            )
            .map((person) => (
              <li key={person.pubkey}>
                <button
                  type="button"
                  aria-label={`Select ${person.label}`}
                  className="min-h-11 w-full truncate rounded-lg px-2 text-left text-sm hover:bg-accent"
                  disabled={busy || locked}
                  onClick={() => add(person.pubkey)}
                >
                  {person.label}
                </button>
              </li>
            ))}
        </ul>
        {error && (
          <p
            role="alert"
            className="whitespace-pre-wrap break-words text-sm text-coral-ink"
          >
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            className="min-h-11"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            className="min-h-11"
            disabled={busy || locked || !selected.length}
            onClick={() => void submit()}
          >
            {busy ? "Adding…" : "Add people"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
