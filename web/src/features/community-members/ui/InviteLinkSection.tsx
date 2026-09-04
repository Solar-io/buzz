import { Check, Copy, Link2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/shared/ui/button";

import { mintInvite } from "../hooks.ts";
import {
  DEFAULT_INVITE_TTL_SECS,
  INVITE_TTL_OPTIONS,
  INVITE_USE_OPTIONS,
  inviteUrlForCode,
  type MintedInvite,
} from "../lib/inviteOptions.ts";

/**
 * Mint a shareable invite.
 *
 * Nothing is minted until the operator asks: an invite is a durable database
 * row that admits strangers, so it is not created as a side effect of opening
 * a screen. (The desktop mints eagerly whenever its dialog opens and again on
 * every settings change, which leaves a trail of live invites behind a user
 * who was only looking.)
 */
export function InviteLinkSection() {
  const [ttlSecs, setTtlSecs] = useState(DEFAULT_INVITE_TTL_SECS);
  const [maxUses, setMaxUses] = useState<number | null>(null);
  const [invite, setInvite] = useState<MintedInvite | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  // The relay builds `url` from the tenant host it knows about, which on a
  // split deployment is not necessarily this origin. The code is the
  // authoritative half, so the link is rebuilt locally and the relay's own
  // URL is kept only as a fallback.
  const link = invite
    ? inviteUrlForCode(window.location.origin, invite.code) || invite.url
    : "";

  const generate = async () => {
    setBusy(true);
    setCopied(false);
    try {
      setInvite(await mintInvite({ ttlSecs, maxUses }));
    } catch (error) {
      setInvite(null);
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not create an invite link.",
      );
    } finally {
      setBusy(false);
    }
  };

  const copy = () => {
    void navigator.clipboard
      ?.writeText(link)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1_500);
      })
      .catch(() => toast.error("Could not copy — clipboard unavailable."));
  };

  return (
    <div className="space-y-3" data-testid="invite-link-section">
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs text-muted-foreground" htmlFor="invite-ttl">
          Expires in
        </label>
        <select
          className="h-8 rounded-md border border-input/40 bg-background px-2 text-xs"
          data-testid="invite-ttl"
          id="invite-ttl"
          onChange={(event) => {
            setTtlSecs(Number(event.target.value));
            setInvite(null);
          }}
          value={ttlSecs}
        >
          {INVITE_TTL_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <label className="text-xs text-muted-foreground" htmlFor="invite-uses">
          Uses
        </label>
        <select
          className="h-8 rounded-md border border-input/40 bg-background px-2 text-xs"
          data-testid="invite-uses"
          id="invite-uses"
          onChange={(event) => {
            const raw = event.target.value;
            setMaxUses(raw === "" ? null : Number(raw));
            setInvite(null);
          }}
          value={maxUses === null ? "" : String(maxUses)}
        >
          {INVITE_USE_OPTIONS.map((option) => (
            <option
              key={option.label}
              value={option.value === null ? "" : String(option.value)}
            >
              {option.label}
            </option>
          ))}
        </select>

        <Button
          data-testid="invite-generate"
          disabled={busy}
          onClick={() => void generate()}
          size="sm"
          type="button"
          variant="outline"
        >
          <Link2 aria-hidden />
          {busy ? "Creating…" : invite ? "New link" : "Create invite link"}
        </Button>
      </div>

      {invite ? (
        <div className="flex items-center gap-2">
          <code
            className="min-w-0 flex-1 truncate rounded-md border border-border/60 bg-muted/40 px-2 py-1.5 text-2xs"
            data-testid="invite-link"
          >
            {link}
          </code>
          <Button
            aria-label="Copy invite link"
            data-testid="invite-copy"
            onClick={copy}
            size="icon"
            type="button"
            variant="ghost"
          >
            {copied ? (
              <Check aria-hidden className="text-emerald-500" />
            ) : (
              <Copy aria-hidden />
            )}
          </Button>
        </div>
      ) : null}

      {invite ? (
        <p className="text-2xs text-muted-foreground">
          Expires {new Date(invite.expiresAt * 1000).toLocaleString()}
          {invite.maxUses === null
            ? " · unlimited uses"
            : ` · ${invite.usesRemaining ?? invite.maxUses} of ${invite.maxUses} uses left`}
        </p>
      ) : null}
    </div>
  );
}
