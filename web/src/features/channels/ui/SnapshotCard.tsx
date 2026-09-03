import { useEffect, useState } from "react";
import { Bot, Download, Eye, Users } from "lucide-react";
import { toast } from "sonner";
import { fetchSignedBytes, fetchSignedMedia } from "@/shared/api/blossom";
import { cn } from "@/shared/lib/cn";
import type { ResolvedSnapshotCard } from "../lib/snapshotCard.ts";

/**
 * Timeline card for a classified agent/team snapshot attachment — the web
 * presentation mirror of the desktop's AgentSnapshotCard.tsx (thumb or icon,
 * display name, "Shared by … · size", Download, and the action that opens
 * review). Honest-state discipline: the thumb falls back to the kind icon on
 * any load failure, and the card itself stays CHEAP — the verified
 * fetch + decode happens in the preview dialog (A12), never here.
 *
 * DELTA from the desktop card: "Add agent" is not on the card. The web flow
 * is review-then-act — the preview dialog owns the only create action, so a
 * user can never mint an agent from an unverified/unreviewed manifest.
 */

function formatSize(size: number | undefined): string | null {
  if (size == null) {
    return null;
  }
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function SnapshotCard({
  card,
  sharedBy,
  onPreview,
}: {
  card: ResolvedSnapshotCard;
  sharedBy?: string;
  /** Opens the verified preview dialog; absent (ForumView/SearchPanel) hides the button. */
  onPreview?: () => void;
}) {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [thumbFailed, setThumbFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setThumbUrl(null);
    setThumbFailed(false);
    if (!card.thumb) {
      return;
    }
    fetchSignedMedia(card.thumb)
      .then((url) => {
        if (!cancelled) {
          setThumbUrl(url);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setThumbFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [card.thumb]);

  async function handleDownload() {
    try {
      const bytes = await fetchSignedBytes(card.href);
      const blob = new Blob([bytes as unknown as BlobPart]);
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = card.filename;
      anchor.rel = "noopener";
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : `Couldn't download this ${card.snapshotKind}.`,
      );
    }
  }

  const SnapshotIcon = card.snapshotKind === "team" ? Users : Bot;
  const showThumb = !!card.thumb && !thumbFailed && !!thumbUrl;
  const formattedSize = formatSize(card.size);
  const metadata = [sharedBy ? `Shared by ${sharedBy}` : null, formattedSize]
    .filter(Boolean)
    .join(" · ");

  return (
    <span
      className="my-1 inline-flex w-fit max-w-full items-center gap-2 rounded-lg border border-border bg-card px-2 py-1.5"
      data-testid="web-snapshot-card"
    >
      <span
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md",
          showThumb ? "" : "bg-primary/10 text-primary ring-1 ring-primary/20",
        )}
      >
        {showThumb ? (
          <img
            src={thumbUrl}
            alt=""
            className="h-full w-full object-cover"
            data-testid="web-snapshot-card-thumb"
          />
        ) : (
          <SnapshotIcon aria-hidden className="h-5 w-5" />
        )}
      </span>
      <span className="min-w-0">
        <span
          className="block truncate text-sm font-medium"
          title={card.displayName}
        >
          {card.displayName}
        </span>
        {metadata ? (
          <span className="block text-xs text-muted-foreground">
            {metadata}
          </span>
        ) : null}
      </span>
      <span className="ml-1 flex shrink-0 items-center gap-1">
        <button
          type="button"
          aria-label={`Download ${card.displayName}`}
          data-testid="web-snapshot-card-download"
          className="rounded p-1 text-muted-foreground hover:bg-accent"
          onClick={() => void handleDownload()}
        >
          <Download aria-hidden className="h-4 w-4" />
        </button>
        {onPreview ? (
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
            data-testid="web-snapshot-card-preview"
            onClick={onPreview}
          >
            <Eye aria-hidden className="h-3.5 w-3.5" />
            Preview
          </button>
        ) : null}
      </span>
    </span>
  );
}
