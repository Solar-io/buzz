import { useId, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { uploadBlob } from "@/shared/api/blossom";
import { AuthorAvatar } from "@/features/channels/ui/AuthorAvatar";
import { acceptAvatarDescriptor } from "../../../lib/avatarUpload";
import type { RosterRow } from "../../../lib/roster";
import type { CardFields } from "./cardTypes";

/** Linked instructions belong to the definition; standalone instructions to this agent. */
export function IdentityCard({
  row,
  fields,
}: {
  row: RosterRow;
  fields: CardFields;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const nameId = useId();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const upload = async (file: File) => {
    if (fields.disabled || fields.controlsLocked || uploading) return;
    setUploading(true);
    setError(null);
    try {
      const result = acceptAvatarDescriptor(await uploadBlob(file));
      if ("error" in result) setError(result.error);
      else fields.edit("avatarUrl", result.url);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not upload the image.",
      );
    } finally {
      setUploading(false);
    }
  };
  return (
    <section
      className="space-y-4 rounded-xl border border-border bg-card p-4"
      data-testid="identity-card"
    >
      <h2 className="text-sm font-semibold">Identity &amp; instructions</h2>
      <div className="flex min-w-0 items-start gap-4">
        <div className="flex shrink-0 flex-col items-center gap-2">
          <AuthorAvatar
            pubkey={row.pubkey}
            label={row.name}
            picture={String(fields.value("avatarUrl") || "")}
            className="size-14 rounded-none bg-muted text-base [clip-path:polygon(50%_0,100%_25%,100%_75%,50%_100%,0_75%,0_25%)]"
          />
          <input
            ref={picker}
            type="file"
            accept="image/*"
            aria-label="Upload agent avatar"
            className="hidden"
            disabled={fields.disabled || fields.controlsLocked || uploading}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
              event.target.value = "";
            }}
          />
          <Button
            variant="outline"
            className="min-h-11"
            disabled={fields.disabled || fields.controlsLocked || uploading}
            onClick={() => picker.current?.click()}
          >
            {uploading ? "Uploading…" : "Change"}
          </Button>
        </div>
        <div className="min-w-0 flex-1 space-y-3">
          <label
            htmlFor={nameId}
            className="block space-y-1 text-xs text-muted-foreground"
          >
            Name
            <Input
              id={nameId}
              aria-label="Agent name"
              value={String(fields.value("name"))}
              disabled={fields.disabled}
              onChange={(event) => fields.edit("name", event.target.value)}
              className="min-h-11 text-sm"
            />
          </label>
          {row.personaLinked ? (
            <div className="space-y-2 rounded-lg border border-info-line bg-info-soft p-3 text-xs">
              <p>
                Instructions come from the definition{" "}
                {row.persona?.name ?? row.name}. Editing it changes every agent
                using that definition at its next restart.
              </p>
              <Button asChild variant="outline" className="min-h-11">
                <Link
                  to="/repos/settings"
                  search={{
                    group: "library",
                    tab: "definitions",
                    definition: row.entry.personaId ?? undefined,
                  }}
                >
                  Edit definition
                </Link>
              </Button>
            </div>
          ) : null}
        </div>
      </div>
      {!row.personaLinked && (
        <label className="block space-y-1 text-xs text-muted-foreground">
          System prompt
          <textarea
            aria-label="System prompt"
            rows={6}
            value={String(fields.value("systemPrompt"))}
            disabled={fields.disabled}
            onChange={(event) =>
              fields.edit("systemPrompt", event.target.value)
            }
            className="w-full resize-y rounded-md border border-input bg-background p-3 text-sm text-foreground"
          />
          <span className="block">
            Changes apply on restart. Clearing instructions needs a Buzz Desktop
            update.
          </span>
        </label>
      )}
      {error && (
        <p role="alert" className="text-xs text-coral-ink">
          {error}
        </p>
      )}
    </section>
  );
}
