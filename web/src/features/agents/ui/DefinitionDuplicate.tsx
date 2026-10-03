import { useState } from "react";
import { toast } from "sonner";
import type { RelaySession } from "@/shared/api/relay-session";
import { ownPubkey, type SignedNostrEvent } from "@/shared/lib/nostr-signer";
import { Button } from "@/shared/ui/button";
import { buildPersonaDuplicate } from "../lib/personaEdit";
import { publishSigned } from "./publishSigned";

/** A duplicate is a private, independently editable definition. */
export function DefinitionDuplicate({
  base,
  session,
  onDuplicated,
}: {
  base: SignedNostrEvent;
  session: RelaySession;
  onDuplicated: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const duplicate = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if ((await ownPubkey()) !== base.pubkey) {
        toast.error("Only the definition's owner can duplicate it.");
        return;
      }
      const id = crypto.randomUUID();
      const built = buildPersonaDuplicate(
        base,
        id,
        Math.floor(Date.now() / 1000),
      );
      if ("error" in built) {
        toast.error(built.error);
        return;
      }
      const result = await publishSigned(
        session,
        built.template,
        "The relay rejected the copy.",
      );
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success("Definition duplicated");
      onDuplicated(id);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not duplicate the definition.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={busy}
      onClick={() => void duplicate()}
    >
      {busy ? "Duplicating…" : "Duplicate"}
    </Button>
  );
}
