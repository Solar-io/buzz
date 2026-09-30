import type { CSSProperties } from "react";
import { toast, Toaster as Sonner, useSonner } from "sonner";
import { useTheme } from "@/shared/theme/ThemeProvider";

type ToasterProps = React.ComponentProps<typeof Sonner>;

/** Toasts on screen at once; the rest wait behind "N more · Clear all". */
export const VISIBLE_TOASTS = 3;
/**
 * Main.dc.html: the stack sits 16px in from the right and 66px down — inside
 * the Work rail's column and clear of its header row (title, scope toggle,
 * fold), so a toast never covers the controls it is next to.
 */
const OFFSET_TOP_PX = 66;
const OFFSET_RIGHT_PX = 16;
const WIDTH_PX = 348;
const MOBILE_TOP = "calc(env(safe-area-inset-top) + 52px)";
/** Height the stack header takes above the toasts, incl. its gap. */
const HEADER_PX = 34;

/**
 * Top-right toasts (kept where they were — Sam, 2026-09-29), restyled onto the
 * redesign's elevated card. The redesign variants (`notify.ts`) render their
 * own card through `toast.custom`; every other `toast.*` call in the app
 * keeps sonner's renderer with these classes, so both read as one surface.
 *
 * The stack is a plain list (`expand`), as on the Toasts artboard: a decision
 * toast hidden behind a newer one is a decision nobody can see. At most three
 * show; past that a header reads "N more · Clear all". It sits above the
 * stack rather than below, where it would move every time a toast's height
 * changed.
 */
const Toaster = ({ ...props }: ToasterProps) => {
  const { isDark } = useTheme();
  const { toasts } = useSonner();
  const hidden = Math.max(0, toasts.length - VISIBLE_TOASTS);
  const shift = hidden > 0 ? HEADER_PX : 0;

  return (
    <>
      {hidden > 0 && (
        <div
          data-testid="toast-stack-header"
          // Sonner's own phone breakpoint is 600px, not a Tailwind one.
          // Desktop geometry rides CSS vars so the phone classes can override.
          className="fixed top-[var(--t)] right-[var(--r)] z-[1000000000] flex w-[var(--w)] items-center justify-between px-1 text-xs text-muted-foreground max-[600px]:top-[calc(env(safe-area-inset-top)+52px)] max-[600px]:right-4 max-[600px]:left-4 max-[600px]:w-auto"
          style={
            {
              "--t": `${OFFSET_TOP_PX}px`,
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
        visibleToasts={VISIBLE_TOASTS}
        style={{ "--width": `${WIDTH_PX}px` } as CSSProperties}
        offset={{ top: OFFSET_TOP_PX + shift, right: OFFSET_RIGHT_PX }}
        // Sonner makes the toaster full-width below 600px. On a phone that puts
        // it over the shell's top bar, which is its own kind of collision, so
        // below md it sits just under the bar instead. 45px is the phone bar's
        // min-height (AppShell.tsx); this stays a plain value rather than a
        // class because sonner writes the offset as an inline CSS var.
        mobileOffset={{
          top: shift ? `calc(${MOBILE_TOP} + ${shift}px)` : MOBILE_TOP,
          left: 16,
          right: 16,
        }}
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
