import { useEffect, useState } from "react";

/**
 * The `beforeinstallprompt` event, which Chromium fires only when the page
 * passes installability and the user has not already installed the app.
 * Safari never fires it — the hook simply stays hidden there.
 */
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export type InstallPromptState =
  | { phase: "hidden" }
  | { phase: "available"; prompt: () => void };

/**
 * Exposes the browser's native install offer as an in-app action.
 *
 * Hidden unless the browser has actually raised `beforeinstallprompt` — a
 * button that cannot act is noise, and the browser's own omnibox affordance
 * already covers the rest. Prompting consumes the event (Chromium allows it
 * once per page load), so the offer hides after the user answers either way;
 * `appinstalled` hides it too, without waiting on a choice.
 */
export function useInstallPrompt(): InstallPromptState {
  const [state, setState] = useState<InstallPromptState>({ phase: "hidden" });

  useEffect(() => {
    // Already running as the installed app — there is nothing to offer.
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
    if (standalone) {
      return;
    }

    let deferred: InstallPromptEvent | null = null;

    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      deferred = event as InstallPromptEvent;
      setState({
        phase: "available",
        prompt: () => {
          const pending = deferred;
          deferred = null;
          if (!pending) {
            return;
          }
          pending
            .prompt()
            .then(() => pending.userChoice)
            .then(() => setState({ phase: "hidden" }))
            .catch(() => setState({ phase: "hidden" }));
        },
      });
    };
    const onInstalled = () => setState({ phase: "hidden" });

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  return state;
}
