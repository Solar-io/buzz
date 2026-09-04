import { useEffect, useState } from "react";

import { ownPubkey } from "@/shared/lib/nostr-signer";

import {
  PRESENCE_HEARTBEAT_INTERVAL_MS,
  PRESENCE_IDLE_TIMEOUT_MS,
} from "../lib/presenceStatus.ts";
import { useSelfPresence } from "../hooks.ts";
import { PresenceStatusMenu } from "./PresenceStatusMenu.tsx";

/**
 * "Your presence" — the settings surface for the viewer's own status.
 *
 * This card is also what keeps the heartbeat honest in review: the copy
 * states the cadence and the idle window, so a change to either constant that
 * nobody meant to make is visible on a screen rather than only in a diff.
 */
export function PresenceSettingsCard() {
  const [selfPubkey, setSelfPubkey] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void ownPubkey().then((pubkey) => {
      if (!cancelled) {
        setSelfPubkey(pubkey);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const presence = useSelfPresence(selfPubkey);
  const idleMinutes = Math.round(PRESENCE_IDLE_TIMEOUT_MS / 60_000);
  const heartbeatSeconds = Math.round(PRESENCE_HEARTBEAT_INTERVAL_MS / 1_000);

  return (
    <section
      className="space-y-2 rounded-lg border border-border bg-card p-4"
      data-testid="settings-presence"
    >
      <div className="flex items-center justify-between gap-4">
        <h2 className="font-medium">Your presence</h2>
        <PresenceStatusMenu
          onSelect={presence.setStatus}
          preference={presence.preference}
          status={presence.status}
        />
      </div>
      <p className="text-sm text-muted-foreground">
        Buzz re-publishes your status every {heartbeatSeconds} seconds while
        this tab is open, and drops you to Away after {idleMinutes} idle
        minutes. Closing the tab publishes offline.
      </p>
    </section>
  );
}
