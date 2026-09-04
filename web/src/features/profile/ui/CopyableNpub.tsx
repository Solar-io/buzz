import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { cn } from "@/shared/lib/cn";
import { npubLabel, toNpub } from "../lib/npub.ts";

/** How long the button holds its "copied" tick before reverting. */
const COPIED_FEEDBACK_MS = 1500;

/**
 * The identity line: a truncated npub that copies the full one.
 *
 * Truncated for the card, full on the clipboard — a shortened key is a
 * recognition aid and is grindable, so the thing a user pastes elsewhere must
 * always be the complete npub.
 */
export function CopyableNpub({
  pubkey,
  className,
}: {
  pubkey: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const npub = toNpub(pubkey);

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    const value = npub ?? pubkey;
    // `navigator.clipboard` is absent on insecure origins; optional-call so a
    // plain-http preview degrades to the toast instead of throwing.
    void navigator.clipboard
      ?.writeText(value)
      .then(() => {
        setCopied(true);
        toast.success("Copied npub");
      })
      .catch(() => toast.error("Could not copy — clipboard unavailable."));
  };

  return (
    <button
      aria-label={`Copy npub ${npubLabel(pubkey)}`}
      className={cn(
        "group/npub inline-flex max-w-full items-center gap-1 rounded-md px-1 py-0.5 font-mono text-2xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring",
        className,
      )}
      data-testid="profile-npub"
      onClick={copy}
      type="button"
    >
      <span className="truncate">{npubLabel(pubkey)}</span>
      {copied ? (
        <Check aria-hidden className="size-3 shrink-0 text-emerald-500" />
      ) : (
        <Copy aria-hidden className="size-3 shrink-0 opacity-60" />
      )}
    </button>
  );
}
