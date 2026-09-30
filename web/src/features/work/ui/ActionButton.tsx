import type { ReactNode } from "react";

import { cn } from "@/shared/lib/cn";

/** `rail` = the docked Work tab (28 px); `page` = the phone page (44 px). */
export type ActionSize = "rail" | "page";

type Tone = "primary" | "secondary" | "ghost" | "dashed";

/** The Work rows' one button recipe, in the canvas's four weights. */
export function ActionButton({
  children,
  tone = "secondary",
  size,
  disabled,
  grow,
  onClick,
  label,
}: {
  children: ReactNode;
  tone?: Tone;
  size: ActionSize;
  disabled?: boolean;
  grow?: boolean;
  onClick: () => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={cn(
        "inline-flex min-w-0 items-center justify-center gap-1.5 whitespace-nowrap font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60",
        size === "rail"
          ? "h-7 rounded-[7px] px-3 text-xs"
          : "h-11 rounded-[10px] px-4 text-base",
        grow && "flex-1",
        tone === "primary" &&
          "border border-primary bg-primary text-primary-foreground hover:opacity-90",
        tone === "secondary" &&
          "border border-input bg-card text-ink-2 hover:bg-accent hover:text-foreground",
        tone === "ghost" &&
          "border-0 bg-transparent text-muted-foreground hover:text-foreground",
        tone === "dashed" &&
          "border border-dashed border-input bg-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/** Verdict line under the buttons — the relay's words, verbatim. */
export function Verdict({ text, error }: { text: string; error?: boolean }) {
  return (
    <p
      className={cn(
        "mt-1.5 break-words font-mono text-2xs",
        error ? "text-coral-ink" : "text-muted-foreground",
      )}
    >
      {text}
    </p>
  );
}
