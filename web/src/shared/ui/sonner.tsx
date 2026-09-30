import { toast, Toaster as Sonner, useSonner } from "sonner";
import { useTheme } from "@/shared/theme/ThemeProvider";

type ToasterProps = React.ComponentProps<typeof Sonner>;

/** Toasts on screen at once; the rest wait behind "N more · Clear all". */
export const VISIBLE_TOASTS = 3;
/** Sonner's own default offsets (desktop / phone), kept as the baseline. */
const OFFSET_TOP_PX = 24;
const MOBILE_TOP = "calc(env(safe-area-inset-top) + 52px)";
/** Height the stack header takes above the toasts, incl. its gap. */
const HEADER_PX = 32;

/**
 * Top-right toasts (kept where they were — Sam, 2026-09-29), restyled onto the
 * redesign's elevated card. The redesign variants (`notify.ts`) render their
 * own card through `toast.custom`; every other `toast.*` call in the app
 * keeps sonner's renderer with these classes, so both read as one surface.
 *
 * At most three show. Past that a header reads "N more · Clear all" above
 * the stack — above rather than below because sonner's stack grows on hover,
 * and a header under it would jump.
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
          className="fixed top-6 right-6 z-[1000000000] flex w-[356px] items-center justify-between rounded-lg bg-popover/90 px-3 py-1 text-xs text-muted-foreground shadow-elev backdrop-blur-sm max-[600px]:top-[calc(env(safe-area-inset-top)+52px)] max-[600px]:right-4 max-[600px]:left-4 max-[600px]:w-auto"
        >
          <span>{hidden} more</span>
          <button
            type="button"
            className="h-6 rounded-md px-2 font-semibold text-info-ink hover:bg-accent"
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
        visibleToasts={VISIBLE_TOASTS}
        offset={{ top: OFFSET_TOP_PX + shift, right: 24 }}
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
