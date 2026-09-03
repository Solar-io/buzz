import * as React from "react";
import { Slot } from "@radix-ui/react-slot";

import { cn } from "@/shared/lib/cn";

export interface SeparatorProps extends React.ComponentPropsWithoutRef<"div"> {
  asChild?: boolean;
  /** Hides the element from the accessibility tree (`role="none"`). */
  decorative?: boolean;
  orientation?: "horizontal" | "vertical";
}

/**
 * Ported from the desktop client's shared/ui/separator.tsx with one deliberate
 * divergence: web does not depend on `@radix-ui/react-separator`, so the DOM
 * contract is reproduced directly instead of wrapping the primitive.
 *
 * That contract is what Radix's Separator emits, and it is reproduced exactly:
 * a `data-orientation` attribute on every render, `role="none"` when decorative,
 * and `role="separator"` plus `aria-orientation` (vertical only — `horizontal`
 * is the ARIA default and is omitted) otherwise. The class strings are desktop's
 * verbatim. Swapping this for the Radix wrapper later is a drop-in change.
 */
const Separator = React.forwardRef<HTMLDivElement, SeparatorProps>(
  (
    {
      asChild = false,
      className,
      decorative = true,
      orientation = "horizontal",
      ...props
    },
    ref,
  ) => {
    const Comp = asChild ? Slot : "div";
    const semanticProps = decorative
      ? ({ role: "none" } as const)
      : ({
          "aria-orientation":
            orientation === "vertical" ? orientation : undefined,
          role: "separator",
        } as const);

    return (
      <Comp
        data-orientation={orientation}
        {...semanticProps}
        className={cn(
          "shrink-0 bg-border",
          orientation === "horizontal" ? "h-[1px] w-full" : "h-full w-[1px]",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Separator.displayName = "Separator";

export { Separator };
