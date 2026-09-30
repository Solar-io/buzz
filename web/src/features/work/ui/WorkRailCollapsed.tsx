import { PanelRightOpen } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/shared/lib/cn";
import { StateHex } from "@/shared/ui/HexAvatar";

/**
 * The Work rail folded to a 44 px strip (phase-1 §3): expand, the need count
 * on a coral hex, and the running count. A NEW need pulses the badge so a
 * folded rail still says "something arrived".
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

  return (
    <div
      data-testid="work-rail-collapsed"
      className="flex h-full w-11 flex-col items-center gap-3 bg-rail py-3"
    >
      <button
        type="button"
        aria-label="Expand Work"
        onClick={onExpand}
        className="grid size-8 place-items-center rounded-lg text-ink-2 hover:bg-accent hover:text-foreground"
      >
        <PanelRightOpen aria-hidden className="size-4" />
      </button>
      {needs > 0 && (
        <button
          type="button"
          onClick={onExpand}
          aria-label={`${needs} need you`}
          className="relative grid place-items-center"
        >
          <span
            className={cn(
              "buzz-hex grid size-7 place-items-center bg-need font-mono text-2xs font-semibold text-need-foreground",
              pulse && "motion-safe:animate-pulse",
            )}
            style={{ height: "2rem" }}
          >
            {needs > 99 ? "99+" : needs}
          </span>
        </button>
      )}
      {running > 0 && (
        <span
          className="flex flex-col items-center gap-1 font-mono text-2xs text-honey-ink"
          title={`${running} running`}
        >
          <StateHex tone="work" size={10} pulse />
          {running}
        </span>
      )}
    </div>
  );
}
