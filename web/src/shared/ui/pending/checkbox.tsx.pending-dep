import * as React from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";

import { cn } from "@/shared/lib/cn";
import "./checkbox.css";

// Ported from the desktop client's shared/ui/checkbox.tsx. The class strings and
// the tick geometry are identical; the one divergence is the animation driver.
//
// Desktop animates the tick with `motion/react`. Web has no `motion`
// dependency and pulling one in for a single stroke draw is a poor trade, so
// the same 180ms cubic-bezier(0.23, 1, 0.32, 1) draw — and Motion's
// `useReducedMotion` skip — are expressed in CSS instead (see ./checkbox.css).
// `pathLength={1}` normalises the path's geometric length so that
// `strokeDashoffset` 1 → 0 is exactly Motion's `pathLength` 0 → 1.

const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      "peer h-4 w-4 shrink-0 rounded-xs border border-primary ring-offset-background focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground",
      className,
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current">
      <svg
        aria-hidden="true"
        className="h-4 w-4"
        fill="none"
        viewBox="0 0 24 24"
      >
        <path
          className="buzz-checkbox-tick"
          d="m5 12 4 4L19 6"
          pathLength={1}
          stroke="currentColor"
          strokeDasharray={1}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
        />
      </svg>
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = CheckboxPrimitive.Root.displayName;

export { Checkbox };
