import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { RelaySession, type RelaySessionStatus } from "./relay-session";
import { relayWsUrl } from "../lib/relay-url";

interface RelaySessionContextValue {
  session: RelaySession;
  status: RelaySessionStatus;
}

const RelaySessionContext = createContext<RelaySessionContextValue | null>(
  null,
);

export function RelaySessionProvider({
  children,
  enabled,
}: {
  children: ReactNode;
  /** Connect only when the app can actually sign (key unlocked or extension). */
  enabled: boolean;
}) {
  const [status, setStatus] = useState<RelaySessionStatus>("idle");

  const session = useMemo(
    () =>
      new RelaySession({
        wsUrl: relayWsUrl(),
        onStatusChange: (next) => setStatus(next),
      }),
    [],
  );

  // Connect on enable — but do NOT close on the enable flip's cleanup: child
  // effects (page subscriptions) run BEFORE this effect's cleanup, so a
  // close() here wipes activeSubs and silently eats every subscription that
  // mounted in the same commit as the false→true transition (seen live: the
  // agents page's channel list never fired its REQ). The session is torn
  // down on unmount only; disabling keeps the socket (the relay gates reads
  // server-side) and re-enable's connect() is a no-op when already open.
  useEffect(() => {
    if (enabled) {
      session.connect();
    }
  }, [session, enabled]);
  useEffect(() => {
    return () => {
      session.close();
    };
  }, [session]);

  const value = useMemo(() => ({ session, status }), [session, status]);
  return (
    <RelaySessionContext.Provider value={value}>
      {children}
    </RelaySessionContext.Provider>
  );
}

export function useRelaySession(): RelaySessionContextValue {
  const context = useContext(RelaySessionContext);
  if (!context) {
    throw new Error(
      "useRelaySession must be used inside <RelaySessionProvider>",
    );
  }
  return context;
}
