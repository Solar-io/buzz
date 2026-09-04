/**
 * Community invites — minting, the half the web was missing.
 *
 * The web client could already *claim* an invite (`/invite/$code`); creating
 * one was desktop-only, even though `POST /api/invites` is an ordinary
 * NIP-98-signed HTTP call. The relay authorises owner/admin and says so
 * plainly on refusal, so this card does not pre-gate on a role: it shows the
 * relay's own message rather than guessing at a permission it cannot see
 * without a membership snapshot.
 */

import { useState } from "react";
import { Check, Copy, Ticket } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { cn } from "@/shared/lib/cn";

import {
  DEFAULT_INVITE_TTL_SECS,
  describeTtl,
  MAX_INVITE_USES,
  TTL_PRESETS,
  type MintedInvite,
} from "../lib/inviteMint.ts";
import { mintInvite } from "../inviteApi";

const selectClass = cn(
  "h-9 rounded-md border border-input bg-background px-2 text-sm",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
);

export function InvitesCard() {
  const [ttl, setTtl] = useState<number>(DEFAULT_INVITE_TTL_SECS);
  const [uses, setUses] = useState("");
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState<MintedInvite | null>(null);
  const [copied, setCopied] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      const trimmed = uses.trim();
      const minted = await mintInvite({
        ttlSecs: ttl,
        maxUses: trimmed === "" ? null : Number.parseInt(trimmed, 10),
      });
      setInvite(minted);
      setCopied(false);
      toast.success("Invite created");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not create an invite.",
      );
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!invite) return;
    try {
      await navigator.clipboard.writeText(invite.url);
      setCopied(true);
      toast.success("Invite link copied");
    } catch {
      toast.error("Could not copy — select the link and copy it manually.");
    }
  };

  return (
    <section
      className="space-y-3 rounded-lg border border-border bg-card p-4"
      data-testid="invites-card"
    >
      <h2 className="font-medium">Invites</h2>
      <p className="text-sm text-muted-foreground">
        Create a link that lets someone join this community. Owners and admins
        only — the relay decides.
      </p>

      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <label className="block text-xs font-medium" htmlFor="invite-ttl">
            Expires after
          </label>
          <select
            className={selectClass}
            id="invite-ttl"
            onChange={(event) => setTtl(Number(event.target.value))}
            value={ttl}
          >
            {TTL_PRESETS.map((preset) => (
              <option key={preset} value={preset}>
                {describeTtl(preset)}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label className="block text-xs font-medium" htmlFor="invite-uses">
            Max uses
          </label>
          <Input
            className="w-32"
            id="invite-uses"
            inputMode="numeric"
            max={MAX_INVITE_USES}
            min={1}
            onChange={(event) => setUses(event.target.value)}
            placeholder="unlimited"
            value={uses}
          />
        </div>
        <Button disabled={busy} onClick={() => void create()} size="sm">
          <Ticket className="mr-1 h-3.5 w-3.5" />
          {busy ? "Creating…" : "Create invite"}
        </Button>
      </div>

      {invite ? (
        <div className="space-y-1 rounded-md border border-border p-3">
          <p className="break-all font-mono text-xs" data-testid="invite-url">
            {invite.url}
          </p>
          <p className="text-xs text-muted-foreground">
            Expires {new Date(invite.expiresAt * 1000).toLocaleString()} ·{" "}
            {invite.maxUses === null
              ? "unlimited uses"
              : `${invite.maxUses} use${invite.maxUses === 1 ? "" : "s"}`}
          </p>
          <Button onClick={() => void copy()} size="sm" variant="outline">
            {copied ? (
              <Check className="mr-1 h-3.5 w-3.5" />
            ) : (
              <Copy className="mr-1 h-3.5 w-3.5" />
            )}
            {copied ? "Copied" : "Copy link"}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
