import * as React from "react";

import { cn } from "@/shared/lib/cn";

// Ported from the desktop client's shared/ui/input.tsx.
//
// `text-base md:text-sm` is load-bearing on the web client specifically: iOS
// Safari zooms the viewport when a focused control's font-size is below 16px,
// so the base size stays 16px on phone widths and only steps down to 14px at
// the `md` breakpoint. Do not flatten it back to a bare `text-sm`.
//
// The three input-behaviour attributes sit BEFORE `{...props}` so a caller that
// genuinely wants spellcheck or autocapitalisation (a display name, a message
// composer) can pass its own value and win.
const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        type={type}
        className={cn(
          "flex h-9 w-full rounded-lg border border-input/40 bg-background px-3 py-1 text-base transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
