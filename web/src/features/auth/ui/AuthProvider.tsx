import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  type AuthState,
  getAuthState,
  initKeyStore,
  lockNow,
  signOut,
  subscribeAuth,
  unlockWithPassphrase,
} from "@/shared/lib/key-store";
import { hasNip07Provider } from "@/shared/lib/nostr-signer";

interface AuthContextValue {
  state: AuthState;
  /** True when the app can sign right now (local key unlocked or extension). */
  canSign: boolean;
  /** True when a stored envelope exists but is locked. */
  isLocked: boolean;
  ready: boolean;
  extensionAvailable: boolean;
  unlock: (passphrase: string) => Promise<void>;
  lock: () => void;
  forgetDevice: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(getAuthState());
  const [ready, setReady] = useState(false);
  const [extensionAvailable, setExtensionAvailable] = useState(false);

  useEffect(() => {
    const unsubscribe = subscribeAuth(setState);
    void initKeyStore().then(() => setReady(true));
    setExtensionAvailable(hasNip07Provider());
    return unsubscribe;
  }, []);

  const unlock = useCallback(async (passphrase: string) => {
    await unlockWithPassphrase(passphrase);
  }, []);
  const lock = useCallback(() => {
    lockNow();
  }, []);
  const forgetDevice = useCallback(async () => {
    await signOut();
  }, []);

  const value = useMemo<AuthContextValue>(() => {
    const unlocked = state.status === "unlocked";
    return {
      state,
      ready,
      extensionAvailable,
      canSign: unlocked || extensionAvailable,
      isLocked: state.status === "locked",
      unlock,
      lock,
      forgetDevice,
    };
  }, [state, ready, extensionAvailable, unlock, lock, forgetDevice]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used inside <AuthProvider>");
  }
  return context;
}
