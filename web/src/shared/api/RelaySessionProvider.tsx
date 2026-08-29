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

  useEffect(() => {
    if (enabled) {
      session.connect();
    }
    return () => {
      session.close();
    };
  }, [session, enabled]);

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
