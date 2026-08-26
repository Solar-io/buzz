import * as React from "react";

import { ensureRelayObserverSubscription } from "./observerRelayStore";

/**
 * Arm the owner-keyed observer frame subscription at app start instead of
 * waiting for an activity panel to open.
 *
 * Observer frames are ephemeral relay events (kind 24200): the relay keeps no
 * history, so a desktop archives only the frames published while it is
 * subscribed. Panel-open-only arming left every desktop except the one
 * hosting the agent sessions with an empty activity archive — this host sees
 * live turns but no history. Boot-time arming makes history accumulate
 * wherever the app is running, which is what the header activity button's
 * archive-backed pane reads.
 *
 * The store handles identity readiness and errors by recording connection
 * state; a failed boot attempt does not block the panel-open path from
 * retrying (startPromise resets in its finally block).
 */
export function ObserverBootstrap() {
  React.useEffect(() => {
    void ensureRelayObserverSubscription();
  }, []);
  return null;
}
