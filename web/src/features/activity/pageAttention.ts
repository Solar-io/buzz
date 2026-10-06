import { useSyncExternalStore } from "react";

/**
 * Is the person actually looking at this page? (invariant I3)
 *
 * A read marker may only advance for a conversation that is ON SCREEN: the
 * tab visible AND the window focused. Without the gate, any Buzz client that
 * merely has a conversation open — a backgrounded Brave tab, a second
 * window, a phone in a pocket — marks every arrival read and NIP-RS carries
 * that to every other device within seconds, clearing the row the user is
 * looking at while its toast is still on screen.
 *
 * In the iOS app the WKWebView's focus is not the user's attention (the app
 * being foreground is), so there visibility alone decides.
 */
export function isPageAttended(): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  if (document.visibilityState !== "visible") {
    return false;
  }
  if (nativeApp()) {
    return true;
  }
  return typeof document.hasFocus === "function" ? document.hasFocus() : true;
}

/** Re-check on every event that can change the answer. */
export function subscribePageAttention(listener: () => void): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => {};
  }
  document.addEventListener("visibilitychange", listener);
  window.addEventListener("focus", listener);
  window.addEventListener("blur", listener);
  window.addEventListener("pageshow", listener);
  return () => {
    document.removeEventListener("visibilitychange", listener);
    window.removeEventListener("focus", listener);
    window.removeEventListener("blur", listener);
    window.removeEventListener("pageshow", listener);
  };
}

/** {@link isPageAttended}, live. */
export function usePageAttended(): boolean {
  return useSyncExternalStore(
    subscribePageAttention,
    isPageAttended,
    () => false,
  );
}

/** Capacitor's native bridge marks the app shell on the global. */
function nativeApp(): boolean {
  const capacitor = (
    globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }
  ).Capacitor;
  return capacitor?.isNativePlatform?.() === true;
}
