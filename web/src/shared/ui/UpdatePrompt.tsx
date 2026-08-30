import { useEffect, useState } from "react";

/**
 * Stale-bundle detector. The SPA keeps running whatever it booted with —
 * deploys never reach an already-open tab, which has repeatedly made fresh
 * features look "not shipped". This polls the served index (no-store) on a
 * timer and on tab focus, compares the hashed entry script against the one
 * this page loaded, and offers a one-click reload when they differ.
 */
export function UpdatePrompt() {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    const loadedScript = document
      .querySelector('script[src*="/assets/index-"]')
      ?.getAttribute("src");
    if (!loadedScript) {
      return;
    }
    let cancelled = false;
    const check = async () => {
      try {
        const response = await fetch("/repos", { cache: "no-store" });
        if (!response.ok) {
          return;
        }
        const html = await response.text();
        const match = html.match(/src="(\/assets\/index-[^"]+\.js)"/);
        if (!cancelled && match && match[1] !== loadedScript) {
          setStale(true);
        }
      } catch {
        // Offline or relay hiccup — try again on the next tick.
      }
    };
    const timer = window.setInterval(check, 90_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void check();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    void check();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (!stale) {
    return null;
  }
  return (
    <button
      type="button"
      className="fixed right-4 bottom-4 z-[60] rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-lg"
      onClick={() => location.reload()}
    >
      Update available — reload
    </button>
  );
}
