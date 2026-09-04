import { useId } from "react";

import { cn } from "@/shared/lib/cn";

/**
 * A mutually exclusive appearance choice — the web counterpart of the
 * desktop's `shared/ui/segmented-control.tsx`.
 *
 * NO HOVER PREVIEW, and that is a deliberate divergence from the desktop.
 * The desktop control auditions an option while you press and drag across the
 * track; it can do that safely because the pointer is CAPTURED, so the control
 * moving underneath it does not break the gesture. Reproducing the same idea
 * with hover in a browser is a trap: previewing "Larger" reflows every line of
 * text above the control, the row slides down, and the option you were
 * pointing at is no longer under the cursor. That is not a hypothetical — the
 * first version of this file did exactly that, and the settings e2e run caught
 * it as a click that landed on the wrong segment.
 *
 * Selecting applies immediately and is one click to undo, and the conversation
 * sample beside these rows shows the result, so the preview earned nothing it
 * did not cost back.
 *
 * Built on REAL radio inputs rather than buttons carrying `role="radio"`. The
 * segment styling comes from the label wrapping each input, so the browser
 * supplies arrow-key navigation, roving focus, form semantics and the
 * announcement of "one of three" for free — none of which a hand-rolled
 * radiogroup gets right without work that is already done here.
 */
export interface SegmentOption<Value extends string> {
  value: Value;
  label: string;
}

export function SegmentedControl<Value extends string>({
  className,
  legend,
  onValueChange,
  optionTestIdPrefix,
  options,
  testId,
  value,
}: {
  className?: string;
  /** Accessible name for the group. */
  legend: string;
  onValueChange: (value: Value) => void;
  optionTestIdPrefix: string;
  options: readonly SegmentOption<Value>[];
  testId: string;
  value: Value;
}) {
  const groupName = useId();

  return (
    <fieldset
      className={cn(
        "inline-flex shrink-0 rounded-lg border border-border bg-muted p-0.5",
        className,
      )}
      data-testid={testId}
    >
      <legend className="sr-only">{legend}</legend>
      {options.map((option) => (
        <label
          className={cn(
            "relative cursor-pointer rounded-md px-3 py-1 text-xs font-medium transition-colors",
            "has-[:focus-visible]:outline-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
            // The selected chip carries a RING as well as a fill. Every colour
            // here is derived at runtime from the chosen syntax theme, and in
            // several of them `--background` and `--muted` land within a few
            // points of lightness of each other — Buzz Dark is 16.1% against
            // 21.2% — so a fill-only selection is nearly invisible. The ring
            // does not depend on that gap.
            option.value === value
              ? "bg-background text-foreground shadow-sm ring-1 ring-border"
              : "text-muted-foreground hover:text-foreground",
          )}
          key={option.value}
        >
          {/*
            The input is transparent and fills the segment rather than being
            `sr-only`. A clipped 1px input is still operable by a person (the
            label forwards the click) but has no hit area of its own, so
            anything that drives the control by the input — Playwright's
            `check()`, a stylus, an assistive pointer — lands on whatever is
            painted over it instead.
          */}
          <input
            checked={option.value === value}
            className="absolute inset-0 cursor-pointer opacity-0"
            data-testid={`${optionTestIdPrefix}-${option.value}`}
            name={groupName}
            onChange={() => onValueChange(option.value)}
            type="radio"
            value={option.value}
          />
          {option.label}
        </label>
      ))}
    </fieldset>
  );
}
