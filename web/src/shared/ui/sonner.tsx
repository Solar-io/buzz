import {
  type CSSProperties,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { toast, Toaster as Sonner, useSonner } from "sonner";
import { useTheme } from "@/shared/theme/ThemeProvider";
import {
  PHONE_TOAST_QUERY,
  stackHeaderTop,
  VISIBLE_TOASTS,
  visibleToastLimit,
} from "./toastStack.ts";

type ToasterProps = React.ComponentProps<typeof Sonner>;

export { VISIBLE_TOASTS };
/**
 * Main.dc.html: the stack sits 16px in from the right and 66px down — inside
 * the Work rail's column and clear of its header row (title, scope toggle,
 * fold), so a toast never covers the controls it is next to.
 */
const OFFSET_TOP_PX = 66;
const OFFSET_RIGHT_PX = 16;
const WIDTH_PX = 348;
const MOBILE_TOP = "calc(env(safe-area-inset-top) + 52px)";
/** Space between the last visible toast and the header under it. */
const HEADER_GAP_PX = 8;
/** How long a stack change keeps being re-measured (sonner animates). */
const SETTLE_MS = 700;

const VISIBLE_TOAST_SELECTOR =
  '[data-sonner-toast][data-visible="true"]:not([data-removed="true"])';

function subscribePhone(onChange: () => void): () => void {
  const query = globalThis.matchMedia?.(PHONE_TOAST_QUERY);
  query?.addEventListener("change", onChange);
  return () => query?.removeEventListener("change", onChange);
}

function phoneSnapshot(): boolean {
  return globalThis.matchMedia?.(PHONE_TOAST_QUERY).matches ?? false;
}

/**
 * Where "N more · Clear all" goes: under the lowest visible toast (Toasts
 * artboard), re-measured while sonner animates the stack into place and
 * whenever the window resizes. Null while nothing is hidden.
 */
function useStackHeaderTop(active: boolean, stackKey: string): number | null {
  const [top, setTop] = useState<number | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: stackKey is the re-measure trigger — any add, remove or breakpoint change moves the stack
  useEffect(() => {
    if (!active) {
      setTop(null);
      return;
    }
    const measure = () => {
      const bottoms = Array.from(
        document.querySelectorAll(VISIBLE_TOAST_SELECTOR),
        (node) => node.getBoundingClientRect().bottom,
      );
      setTop(stackHeaderTop(bottoms, HEADER_GAP_PX));
    };
    const started = performance.now();
    let frame = requestAnimationFrame(function tick() {
      measure();
      if (performance.now() - started < SETTLE_MS) {
        frame = requestAnimationFrame(tick);
      }
    });
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", measure);
    };
  }, [active, stackKey]);
  return top;
}

/**
 * Top-right toasts (kept where they were — Sam, 2026-09-29), restyled onto the
 * redesign's elevated card. The redesign variants (`notify.ts`) render their
 * own card through `toast.custom`; every other `toast.*` call in the app
 * keeps sonner's renderer with these classes, so both read as one surface.
 *
 * The stack is a plain list (`expand`), as on the Toasts artboard: a decision
 * toast hidden behind a newer one is a decision nobody can see. At most three
 * show — ONE on a phone, where there is no corner a toast can sit in without
 * covering the Work cards under it (Phase 1 QA). Past that, "N more · Clear
 * all" sits under the last visible toast.
 */
const Toaster = ({ ...props }: ToasterProps) => {
  const { isDark } = useTheme();
  const { toasts } = useSonner();
  const phone = useSyncExternalStore(
    subscribePhone,
    phoneSnapshot,
    () => false,
  );
  const limit = visibleToastLimit(phone);
  const hidden = Math.max(0, toasts.length - limit);
  const headerTop = useStackHeaderTop(
    hidden > 0,
    `${phone}:${toasts.map((entry) => entry.id).join(",")}`,
  );

  return (
    <>
      {hidden > 0 && headerTop !== null && (
        <div
          data-testid="toast-stack-header"
          // Sonner's own phone breakpoint is 600px, not a Tailwind one.
          className="fixed right-[var(--r)] z-[1000000000] flex w-[var(--w)] items-center justify-between px-1 text-xs text-muted-foreground max-[600px]:right-4 max-[600px]:left-4 max-[600px]:w-auto"
          style={
            {
              top: headerTop,
              "--r": `${OFFSET_RIGHT_PX}px`,
              "--w": `${WIDTH_PX}px`,
            } as CSSProperties
          }
        >
          <span className="rounded-md bg-popover/90 px-2 py-1 shadow-elev backdrop-blur-sm">
            {hidden} more
          </span>
          <button
            type="button"
            className="h-6 rounded-md bg-popover/90 px-2 font-semibold text-info-ink shadow-elev backdrop-blur-sm hover:bg-accent"
            onClick={() => toast.dismiss()}
          >
            Clear all
          </button>
        </div>
      )}
      <Sonner
        theme={isDark ? "dark" : "light"}
        className="toaster group"
        position="top-right"
        expand
        gap={10}
        visibleToasts={limit}
        style={{ "--width": `${WIDTH_PX}px` } as CSSProperties}
        offset={{ top: OFFSET_TOP_PX, right: OFFSET_RIGHT_PX }}
        // Sonner makes the toaster full-width below 600px. On a phone that puts
        // it over the shell's top bar, which is its own kind of collision, so
        // below md it sits just under the bar instead. 45px is the phone bar's
        // min-height (AppShell.tsx); this stays a plain value rather than a
        // class because sonner writes the offset as an inline CSS var.
        mobileOffset={{ top: MOBILE_TOP, left: 16, right: 16 }}
        toastOptions={{
          classNames: {
            toast:
              "group toast group-[.toaster]:rounded-xl group-[.toaster]:bg-popover group-[.toaster]:text-popover-foreground group-[.toaster]:border-input group-[.toaster]:shadow-elev",
            title:
              "group-[.toast]:text-sidebar-meta group-[.toast]:font-semibold",
            description:
              "group-[.toast]:font-mono group-[.toast]:text-2xs group-[.toast]:text-muted-foreground",
            actionButton:
              "group-[.toast]:rounded-[7px] group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
            cancelButton:
              "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
          },
        }}
        {...props}
      />
    </>
  );
};

export { Toaster };
