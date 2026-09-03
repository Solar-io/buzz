import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";

import { cn } from "@/shared/lib/cn";

// Hover-only disclosure should require deliberate pointer dwell. Disabling Radix's
// skip-delay grace prevents tooltips from cascading open while the pointer moves
// across adjacent controls. Callers may override both values for a proven case.
//
// Web previously re-exported the raw Radix `Provider`/`Root`, which meant the
// library defaults applied: a 700ms first-open delay, a 300ms skip-delay window
// during which every subsequent trigger opened instantly, and hoverable content.
const DEFAULT_TOOLTIP_DELAY_MS = 500;
const DEFAULT_TOOLTIP_SKIP_DELAY_MS = 0;

const TooltipProvider = ({
  delayDuration = DEFAULT_TOOLTIP_DELAY_MS,
  skipDelayDuration = DEFAULT_TOOLTIP_SKIP_DELAY_MS,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) => (
  <TooltipPrimitive.Provider
    delayDuration={delayDuration}
    skipDelayDuration={skipDelayDuration}
    {...props}
  />
);

const Tooltip = ({
  disableHoverableContent = true,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) => (
  <TooltipPrimitive.Root
    disableHoverableContent={disableHoverableContent}
    {...props}
  />
);

const TooltipTrigger = TooltipPrimitive.Trigger;

// The surface is `bg-secondary` / `text-secondary-foreground`, not `bg-primary`.
// `--primary` is the Catppuccin mauve accent, which on the dark theme is a LIGHT
// mauve (#c7a0f6) paired with a near-black foreground — so the old `bg-primary`
// tooltip rendered as a bright lavender block, inverted against every other
// floating surface in the app. `--secondary` is the neutral raised surface
// (#363a4f dark / #ccd0da light) with the matching readable foreground.
const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "pointer-events-none z-50 overflow-hidden rounded-md bg-secondary px-3 py-1.5 text-xs text-secondary-foreground animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-(--radix-tooltip-content-transform-origin)",
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
