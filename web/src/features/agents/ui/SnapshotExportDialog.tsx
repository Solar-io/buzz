import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/shared/ui/button";
import { fetchSignedBytes } from "@/shared/api/blossom";
import { relayHttpBaseUrl } from "@/shared/lib/relay-url";
import { useAgentMemoryQuery } from "@/features/agent-memory/hooks";
import type { PersonaDefinition } from "../lib/personas";
import type { RosterRow } from "../lib/roster";
import {
  encodeSnapshotPng,
  MAX_PNG_BODY_EDGE,
  pngDimensions,
} from "../lib/pngText";
import {
  buildDefinitionSnapshot,
  decodeDataUrl,
  encodeSnapshotJson,
  memoryEntriesFromListing,
  snapshotFilename,
  validateEncodeSize,
  type MemoryLevel,
} from "../lib/snapshotExport";

/**
 * Export a kind-30175 definition as a `buzz-agent-snapshot v1` file, built
 * entirely in the browser (snapshotExport.ts mirrors the desktop encoder).
 * Memory comes from one linked agent via the existing engram reader and is
 * offered only when the definition has a linked agent (desktop
 * `validate_memory_source`). The PNG body is the avatar when it resolves to
 * a PNG within 512px (transcoding other images on a canvas), else the 1×1
 * placeholder the importer ignores. Only same-relay `/media/` avatars are
 * fetched.
 */
export function SnapshotExportDialog({
  persona,
  linkedRows,
  onClose,
}: {
  persona: PersonaDefinition;
  linkedRows: readonly RosterRow[];
  onClose: () => void;
}) {
  const [png, setPng] = useState(false);
  const [level, setLevel] = useState<MemoryLevel>("none");
  const [source, setSource] = useState(linkedRows[0]?.pubkey ?? "");
  const [busy, setBusy] = useState(false);
  const memory = useAgentMemoryQuery(level === "none" ? null : source);

  const preview = buildDefinitionSnapshot(persona, {
    level: "none",
    entries: [],
  });
  const notes = "notes" in preview ? preview.notes : [];

  const exportNow = async () => {
    if (busy) {
      return;
    }
    let entries: { slug: string; body: string }[] = [];
    if (level !== "none") {
      if (memory.error) {
        toast.error(memory.error.message);
        return;
      }
      if (!memory.data) {
        toast.error("Memory is still loading.");
        return;
      }
      const selected = memoryEntriesFromListing(memory.data, level);
      if ("error" in selected) {
        toast.error(selected.error);
        return;
      }
      entries = selected;
    }
    const built = buildDefinitionSnapshot(persona, { level, entries });
    if ("error" in built) {
      toast.error(built.error);
      return;
    }
    setBusy(true);
    try {
      const json = encodeSnapshotJson(built.snapshot);
      const bytes = png
        ? encodeSnapshotPng(json, await avatarPngBody(persona))
        : json;
      const tooBig = validateEncodeSize(bytes.length, png);
      if (tooBig) {
        toast.error(tooBig);
        return;
      }
      download(
        bytes,
        snapshotFilename(persona.name, png),
        png ? "image/png" : "application/json",
      );
      toast.success(`Exported ${persona.name}.`);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="absolute inset-0" aria-hidden onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Export ${persona.name}`}
        data-testid="web-snapshot-export"
        className="relative w-full max-w-md space-y-4 rounded-xl border border-border bg-card p-4 shadow-lg"
      >
        <h2 className="text-base font-semibold">Export {persona.name}</h2>
        <fieldset className="space-y-1">
          <legend className="text-sm text-muted-foreground">Format</legend>
          <label className="mr-4 text-sm">
            <input
              type="radio"
              name="snapshot-format"
              checked={!png}
              onChange={() => setPng(false)}
            />{" "}
            JSON (.agent.json)
          </label>
          <label className="text-sm">
            <input
              type="radio"
              name="snapshot-format"
              checked={png}
              onChange={() => setPng(true)}
            />{" "}
            PNG card (.agent.png)
          </label>
        </fieldset>
        <label className="block space-y-1">
          <span className="text-sm text-muted-foreground">Memory</span>
          <select
            aria-label="Memory"
            value={level}
            onChange={(event) => setLevel(event.target.value as MemoryLevel)}
            className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
          >
            <option value="none">None</option>
            {linkedRows.length > 0 && <option value="core">Core</option>}
            {linkedRows.length > 0 && (
              <option value="everything">Everything</option>
            )}
          </select>
        </label>
        {linkedRows.length === 0 && (
          <p className="text-xs text-muted-foreground">
            Memory export needs an agent created from this definition.
          </p>
        )}
        {level !== "none" && (
          <label className="block space-y-1">
            <span className="text-sm text-muted-foreground">
              Memory from agent
            </span>
            <select
              aria-label="Memory source agent"
              value={source}
              onChange={(event) => setSource(event.target.value)}
              className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
            >
              {linkedRows.map((row) => (
                <option key={row.pubkey} value={row.pubkey}>
                  {row.name}
                </option>
              ))}
            </select>
            {memory.isLoading && (
              <span className="text-xs text-muted-foreground">
                Loading memory…
              </span>
            )}
            {memory.error && (
              <span className="text-xs text-destructive">
                {memory.error.message}
              </span>
            )}
          </label>
        )}
        {notes.length > 0 && (
          <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
            {notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        )}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void exportNow()}>
            {busy ? "Exporting…" : "Download"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function download(bytes: Uint8Array, filename: string, type: string) {
  const url = URL.createObjectURL(
    new Blob([bytes as unknown as BlobPart], { type }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function avatarUrlOf(persona: PersonaDefinition): string {
  try {
    const content = JSON.parse(persona.event.content) as Record<
      string,
      unknown
    >;
    return typeof content.avatar_url === "string"
      ? content.avatar_url.trim()
      : "";
  } catch {
    return "";
  }
}

function isRelayMedia(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      parsed.origin === new URL(relayHttpBaseUrl()).origin &&
      parsed.pathname.startsWith("/media/")
    );
  } catch {
    return false;
  }
}

/** The PNG body bytes, or null for the placeholder. Never throws. */
async function avatarPngBody(
  persona: PersonaDefinition,
): Promise<Uint8Array | null> {
  const url = avatarUrlOf(persona);
  try {
    const bytes = url.startsWith("data:")
      ? decodeDataUrl(url)
      : isRelayMedia(url)
        ? await fetchSignedBytes(url)
        : null;
    if (!bytes || bytes.length === 0) {
      return null;
    }
    const dims = pngDimensions(bytes);
    if (
      dims &&
      dims.width <= MAX_PNG_BODY_EDGE &&
      dims.height <= MAX_PNG_BODY_EDGE
    ) {
      return bytes;
    }
    return await transcodeToPng(bytes);
  } catch {
    return null;
  }
}

/** Canvas transcode to a PNG whose longer edge is at most 512px. */
async function transcodeToPng(bytes: Uint8Array): Promise<Uint8Array | null> {
  const bitmap = await createImageBitmap(
    new Blob([bytes as unknown as BlobPart]),
  );
  const scale = Math.min(
    1,
    MAX_PNG_BODY_EDGE / Math.max(bitmap.width, bitmap.height),
  );
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) {
    return null;
  }
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}
