import type * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/shared/lib/cn";

// Ported from the desktop client's shared/ui/badge.tsx: a pill-shaped, uppercase,
// wide-tracked label rather than the rounded-rect sentence-case chip web had.
//
// TODO(typography): the size step is `text-2xs` on desktop (0.6875rem / 11px at a
// 16px type rem, defined in desktop/tailwind.config.js under
// theme.extend.fontSize). Web's tailwind.config.js does not define that token
// yet, so the literal below stands in for it. Once `text-2xs` exists in web's
// config, replace `text-[0.6875rem]` with `text-2xs` — the value is identical, so
// this is a pure token swap with no visual change.
const badgeVariants = cva(
  "inline-flex items-center rounded-full px-2 pb-[3px] pt-[5px] text-[0.6875rem] font-semibold uppercase leading-none tracking-[0.18em]",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground",
        secondary: "bg-muted text-muted-foreground",
        outline:
          "border border-border/70 bg-background/80 text-muted-foreground",
        destructive: "bg-destructive text-destructive-foreground",
        warning: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
        success: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
        info: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
