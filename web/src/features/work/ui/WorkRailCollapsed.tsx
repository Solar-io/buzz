import { ListTodo } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/shared/lib/cn";
import { StateHex } from "@/shared/ui/HexAvatar";

/**
 * The Work rail folded to its 48 px strip — the "Work, collapsed" aside of
 * the Files / Items / Terminal artboards, and the fold of the conversation
 * rail (phase-1 §3): one Work button carrying the need count, then the
 * running count on a pulsing hex. A NEW need pulses the badge so a folded
 * rail still says "something arrived".
 */
export function WorkRailCollapsed({
  needs,
  running,
  onExpand,
}: {
  needs: number;
  running: number;
  onExpand: () => void;
}) {
  const [pulse, setPulse] = useState(false);
  const previous = useRef(needs);
  useEffect(() => {
    if (needs > previous.current) {
      setPulse(true);
      const timer = setTimeout(() => setPulse(false), 4_000);
      previous.current = needs;
      return () => clearTimeout(timer);
    }
    previous.current = needs;
  }, [needs]);

  const label = needs > 0 ? `Expand Work: ${needs} need you` : "Expand Work";
  return (
    <div
      data-testid="work-rail-collapsed"
      className="flex h-full w-12 flex-col items-center gap-3 bg-rail pt-3"
    >
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={onExpand}
        className="relative grid size-8.5 place-items-center rounded-[9px] bg-card text-ink-2 ring-1 ring-border transition-colors hover:text-foreground"
      >
        <ListTodo aria-hidden className="size-4" />
        {needs > 0 && (
          <span
            aria-hidden
            className={cn(
              "absolute -top-1.25 -right-1.5 h-4 min-w-4 rounded-full bg-need px-1 text-center font-mono text-badge leading-4 font-semibold text-need-foreground",
              pulse && "motion-safe:animate-pulse",
            )}
          >
            {needs > 99 ? "99+" : needs}
          </span>
        )}
      </button>
      {running > 0 && (
        <span
          className="flex flex-col items-center gap-0.75 font-mono text-2xs text-muted-foreground"
          title={`${running} running`}
        >
          <StateHex tone="work" size={10} pulse />
          {running}
        </span>
      )}
    </div>
  );
}
