import {
  CircleCheck,
  Info,
  Lightbulb,
  OctagonAlert,
  TriangleAlert,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import {
  CALLOUT_TYPES,
  type CalloutType,
} from "@/shared/lib/remarkCallouts.ts";

/**
 * A GitHub-style callout (web redesign Phase 2; Message artboard), produced
 * by `remarkCallouts` from `> [!NOTE]` and its four siblings.
 *
 * The tones follow how the fleet is told to use them (the agent base prompt):
 * NOTE marks verified facts and tested work, so it is the calm green of a
 * passed check; WARNING marks anything untested or assumed, in amber. TIP is
 * a neutral aside, IMPORTANT is the blue of something to read before acting,
 * CAUTION the coral of something that can hurt. A reader scanning a long
 * agent report should be able to tell tested from untested by colour alone —
 * and, because colour is never the only signal, by the icon and the title.
 */

const TONE: Record<
  CalloutType,
  {
    label: string;
    Icon: typeof Info;
    box: string;
    ink: string;
  }
> = {
  note: {
    label: "Note",
    Icon: CircleCheck,
    box: "border-leaf-line bg-leaf-soft",
    ink: "text-leaf-ink",
  },
  tip: {
    label: "Tip",
    Icon: Lightbulb,
    box: "border-border bg-sunk",
    ink: "text-muted-foreground",
  },
  important: {
    label: "Important",
    Icon: Info,
    box: "border-info-line bg-info-soft",
    ink: "text-info-ink",
  },
  warning: {
    label: "Warning",
    Icon: TriangleAlert,
    box: "border-honey-line bg-honey-wash",
    ink: "text-honey-ink",
  },
  caution: {
    label: "Caution",
    Icon: OctagonAlert,
    box: "border-coral-line bg-coral-wash",
    ink: "text-coral-ink",
  },
};

function calloutType(value: string | undefined): CalloutType {
  return (CALLOUT_TYPES as readonly string[]).includes(value ?? "")
    ? (value as CalloutType)
    : "note";
}

export function Callout({
  "data-callout": type,
  "data-title": title,
  children,
}: {
  "data-callout"?: string;
  "data-title"?: string;
  children?: ReactNode;
}) {
  const kind = calloutType(type);
  const tone = TONE[kind];
  return (
    <div
      data-testid="callout"
      data-callout={kind}
      role="note"
      className={cn("my-2 rounded-xl border px-3.5 py-3", tone.box)}
    >
      <div
        className={cn(
          "flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.06em]",
          tone.ink,
        )}
      >
        <tone.Icon aria-hidden className="size-3.75 shrink-0" />
        <span className="min-w-0">{title || tone.label}</span>
      </div>
      {children ? (
        <div className="buzz-callout-body mt-1.5 text-sidebar-meta text-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_li]:my-0.5 [&_ol]:my-1 [&_p]:my-1 [&_ul]:my-1">
          {children}
        </div>
      ) : null}
    </div>
  );
}
