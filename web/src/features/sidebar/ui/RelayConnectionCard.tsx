import { RefreshCw, WifiOff } from "lucide-react";
import { useState } from "react";
import type { RelaySessionStatus } from "@/shared/api/relay-session";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { Button } from "@/shared/ui/button";

/**
 * Relay connection state, with a way to act on it.
 *
 * The sidebar previously reported this as an 8×8px dot with a `title`
 * tooltip — which meant a dropped connection was invisible on a touch device,
 * indistinguishable from "quiet" at a glance, and offered nothing to do about
 * it. The session already tracks six states; the boolean the sidebar was
 * given threw five of them away.
 *
 * The card is deliberately absent while the socket is open: a permanent
 * "connected" banner is noise, and the states worth surfacing are the ones
 * where the user is waiting or stuck.
 */

/** What each status means to someone who does not know what a relay is. */
function describe(status: RelaySessionStatus): {
  title: string;
  detail: string;
  /** Transient states are working on it; only stuck ones offer a retry. */
  transient: boolean;
} | null {
  switch (status) {
    case "open":
      return null;
    case "idle":
      return null;
    case "connecting":
      return {
        title: "Connecting…",
        detail: "Reaching the relay.",
        transient: true,
      };
    case "authenticating":
      return {
        title: "Signing in…",
        detail: "Proving your key to the relay.",
        transient: true,
      };
    case "reconnecting":
      return {
        title: "Reconnecting…",
        detail: "The connection dropped. Retrying automatically.",
        transient: true,
      };
    case "closed":
      return {
        title: "Not connected",
        detail: "Messages you send will not be delivered until this returns.",
        transient: false,
      };
  }
}

/** Props for {@link RelayConnectionCard}. */
export interface RelayConnectionCardProps {
  status: RelaySessionStatus;
}

export function RelayConnectionCard({ status }: RelayConnectionCardProps) {
  const { session } = useRelaySession();
  const [dismissed, setDismissed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const state = describe(status);

  // Reset the dismissal when the connection recovers, so the next drop is
  // surfaced again rather than staying silently hidden for the session.
  if (state === null && dismissed) {
    setDismissed(false);
  }

  if (state === null || dismissed) {
    return null;
  }

  const retry = () => {
    setRetrying(true);
    // connect() is a no-op when the socket is already open, so an
    // impatient click during an automatic retry is harmless.
    session.connect();
    window.setTimeout(() => setRetrying(false), 1200);
  };

  return (
    <div
      role="status"
      className="mx-2 mb-2 rounded-md border border-sidebar-border bg-sidebar-accent/60 p-2.5"
    >
      <div className="flex items-start gap-2">
        <WifiOff
          aria-hidden
          className="mt-0.5 size-4 shrink-0 text-sidebar-foreground/70"
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-sidebar-foreground">
            {state.title}
          </p>
          <p className="mt-0.5 text-2xs text-sidebar-foreground/70">
            {state.detail}
          </p>
        </div>
      </div>
      {!state.transient && (
        <div className="mt-2 flex items-center gap-2">
          <Button
            size="xs"
            variant="outline"
            onClick={retry}
            disabled={retrying}
          >
            <RefreshCw
              aria-hidden
              className={retrying ? "size-3.5 animate-spin" : "size-3.5"}
            />
            {retrying ? "Reconnecting…" : "Reconnect"}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setDismissed(true)}
            className="text-sidebar-foreground/70"
          >
            Dismiss
          </Button>
        </div>
      )}
    </div>
  );
}
