import { useState } from "react";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Textarea } from "@/shared/ui/textarea";
import { TTL_PRESETS } from "../../lib/channelMetadataEdit.ts";
import type { ChannelSettingsSheetProps } from "./ChannelSettingsSheet";

const rowClass =
  "flex min-h-12 w-full items-center justify-between gap-3 border-t border-border px-3 py-2 text-left text-sm first:border-t-0 disabled:opacity-50";
const groupClass = "overflow-hidden rounded-xl border border-border bg-card";

export function AboutTab(
  props: ChannelSettingsSheetProps & {
    busy: boolean;
    run: (action: () => Promise<void>) => Promise<void>;
    onMembers: () => void;
  },
) {
  const { channel, busy, run } = props;
  const [editing, setEditing] = useState<"name" | "purpose" | null>(null);
  const [draft, setDraft] = useState("");
  const locked = busy || channel.archived;
  const edit = (field: "name" | "purpose") => {
    setEditing(field);
    setDraft(channel[field]);
  };
  return (
    <div className="space-y-5 pt-5">
      <section aria-label="Details" className="space-y-2">
        <h2 className="px-1 text-2xs uppercase tracking-wider text-muted-foreground">
          Details
        </h2>
        <div className={groupClass}>
          {(["name", "purpose"] as const).map((field) => (
            <div
              key={field}
              className="border-t border-border first:border-t-0"
            >
              <button
                type="button"
                className={rowClass}
                disabled={locked}
                onClick={() => edit(field)}
                aria-label={`Edit ${field}`}
              >
                <span className="capitalize">{field}</span>
                <span className="max-w-[65%] truncate text-ink-2">
                  {channel[field] || "Add a purpose"}
                </span>
              </button>
              {editing === field && !channel.archived && (
                <form
                  className="space-y-2 px-3 pb-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run(async () => {
                      await props.onEdit({ [field]: draft });
                      setEditing(null);
                    });
                  }}
                >
                  <label htmlFor={`channel-edit-${field}`} className="sr-only">
                    {field === "name" ? "Channel name" : "Channel purpose"}
                  </label>
                  {field === "name" ? (
                    <Input
                      id={`channel-edit-${field}`}
                      value={draft}
                      disabled={busy}
                      onChange={(event) => setDraft(event.target.value)}
                    />
                  ) : (
                    <Textarea
                      id={`channel-edit-${field}`}
                      value={draft}
                      disabled={busy}
                      onChange={(event) => setDraft(event.target.value)}
                      rows={3}
                    />
                  )}
                  <div className="flex justify-end gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setEditing(null)}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="submit"
                      disabled={
                        busy ||
                        (field === "name" &&
                          !draft.replace(/^[#\s]+/, "").trim())
                      }
                    >
                      {busy ? "Saving…" : "Save"}
                    </Button>
                  </div>
                </form>
              )}
            </div>
          ))}
          <label className={rowClass}>
            <span>Visibility</span>
            <select
              aria-label="Visibility"
              className="min-h-9 min-w-0 max-w-[65%] rounded bg-card text-right text-sm text-ink-2"
              value={channel.isPrivate ? "private" : "open"}
              disabled={locked}
              onChange={(event) => {
                const visibility = event.target.value as "open" | "private";
                void run(() => props.onEdit({ visibility }));
              }}
            >
              <option value="open">Public</option>
              <option value="private">Private</option>
            </select>
          </label>
          <div className={rowClass}>
            <span>Joining</span>
            <span className="text-ink-2">
              {channel.joining === "anyone" ? "Anyone can join" : "By invite"}
            </span>
          </div>
          <label className={rowClass}>
            <span>Lifetime</span>
            <select
              aria-label="Lifetime"
              className="min-h-9 min-w-0 max-w-[65%] rounded bg-card text-right text-sm text-ink-2"
              disabled={locked}
              value={channel.ttlSeconds ?? ""}
              onChange={(event) => {
                const ttl =
                  event.target.value === "" ? null : Number(event.target.value);
                void run(() => props.onEdit({ ttl }));
              }}
            >
              {TTL_PRESETS.map((preset) => (
                <option
                  key={preset.seconds ?? "ongoing"}
                  value={preset.seconds ?? ""}
                >
                  {preset.label}
                </option>
              ))}
              {channel.ttlSeconds !== null &&
                !TTL_PRESETS.some(
                  (preset) => preset.seconds === channel.ttlSeconds,
                ) && (
                  <option value={channel.ttlSeconds}>
                    Temporary · {channel.ttlSeconds} seconds
                  </option>
                )}
            </select>
          </label>
          <div className={rowClass}>
            <span>
              Type
              <span className="block text-xs text-muted-foreground">
                Chosen when the channel was made
              </span>
            </span>
            <span className="capitalize text-ink-2">{channel.type}</span>
          </div>
        </div>
        <p className="px-1 text-xs text-muted-foreground">
          Joining and type are read-only.
        </p>
      </section>
      <section aria-label="Agents here" className="space-y-2">
        <h2 className="px-1 text-2xs uppercase tracking-wider text-muted-foreground">
          Agents here
        </h2>
        <div className={groupClass}>
          <button
            type="button"
            className={rowClass}
            disabled={locked}
            onClick={props.onMembers}
          >
            <span>
              {props.agentCount} {props.agentCount === 1 ? "agent" : "agents"}
            </span>
            <span className="text-ink-2">Members →</span>
          </button>
        </div>
      </section>
      <section aria-label="Shared" className="space-y-2">
        <h2 className="px-1 text-2xs uppercase tracking-wider text-muted-foreground">
          Shared
        </h2>
        <div className={groupClass}>
          <button
            type="button"
            className={rowClass}
            disabled={locked}
            onClick={props.onCanvas}
          >
            Canvas <span aria-hidden>→</span>
          </button>
          <button
            type="button"
            className={rowClass}
            disabled={locked}
            onClick={() => void run(props.onTemplate)}
          >
            Save as template <span aria-hidden>→</span>
          </button>
        </div>
      </section>
      <section aria-label="For you" className="space-y-2">
        <h2 className="px-1 text-2xs uppercase tracking-wider text-muted-foreground">
          For you
        </h2>
        <div className={groupClass}>
          <label className={rowClass}>
            <span>Notifications</span>
            <select
              aria-label="Notifications"
              className="min-h-9 rounded bg-card text-sm text-ink-2"
              value={props.muted ? "muted" : "enabled"}
              disabled={locked}
              onChange={props.onMute}
            >
              <option value="enabled">Your default</option>
              <option value="muted">Muted</option>
            </select>
          </label>
          <button
            type="button"
            className={rowClass}
            disabled={locked || (!props.isMember && channel.isPrivate)}
            onClick={() =>
              void run(props.isMember ? props.onLeave : props.onJoin)
            }
          >
            {props.isMember ? "Leave channel" : "Join channel"}
          </button>
        </div>
      </section>
      <section aria-label="Channel actions" className="space-y-2">
        <div className={groupClass}>
          <button
            type="button"
            className={rowClass}
            disabled={busy}
            onClick={() =>
              void run(() => props.onEdit({ archived: !channel.archived }))
            }
          >
            <span>
              {channel.archived ? "Unarchive channel" : "Archive channel"}
            </span>
            <span className="text-xs text-muted-foreground">
              Read-only, kept
            </span>
          </button>
          <button
            type="button"
            className={`${rowClass} text-coral-ink`}
            disabled={locked}
            onClick={() => void run(props.onDelete)}
          >
            Delete channel
          </button>
        </div>
        <p className="px-1 text-xs text-muted-foreground">
          {channel.archived
            ? "This channel is archived. Unarchive it to make changes."
            : "Changes apply right away for everyone. The relay checks your permissions."}
        </p>
      </section>
    </div>
  );
}
