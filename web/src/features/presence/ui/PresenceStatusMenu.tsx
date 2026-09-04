import { ChevronDown } from "lucide-react";

import { Button } from "@/shared/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";

import {
  presenceLabel,
  type PresencePreference,
  type PresenceStatus,
} from "../lib/presenceStatus.ts";
import { PresenceDot } from "./PresenceBadge.tsx";

const OPTIONS: Array<{
  status: PresenceStatus;
  label: string;
  hint: string;
}> = [
  {
    status: "online",
    label: "Active",
    hint: "Follows your activity — you go Away on your own after ten idle minutes.",
  },
  {
    status: "away",
    label: "Away",
    hint: "Pinned. Everyone sees Away until you change it back.",
  },
  {
    status: "offline",
    label: "Invisible",
    hint: "Publishes offline once and stops the heartbeat.",
  },
];

/**
 * Pick your own presence.
 *
 * "Active" maps to the *auto* preference, not a pinned online — see
 * `preferenceForManualPick`. The hint text says so, because a control that
 * silently un-pins itself ten minutes later is worse than one that explains
 * itself up front.
 */
export function PresenceStatusMenu({
  status,
  preference,
  onSelect,
}: {
  status: PresenceStatus;
  preference: PresencePreference;
  onSelect: (status: PresenceStatus) => void;
}) {
  const selected: PresenceStatus =
    preference === "auto" ? "online" : preference;
  const trigger =
    preference === "auto"
      ? `${presenceLabel(status)} (auto)`
      : (OPTIONS.find((option) => option.status === selected)?.label ??
        "Active");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          className="gap-2"
          data-testid="presence-status-trigger"
          size="sm"
          type="button"
          variant="outline"
        >
          <PresenceDot status={status} />
          <span>{trigger}</span>
          <ChevronDown aria-hidden className="size-3.5 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuRadioGroup
          onValueChange={(value) => onSelect(value as PresenceStatus)}
          value={selected}
        >
          {OPTIONS.map((option, index) => (
            <div key={option.status}>
              {index > 0 ? <DropdownMenuSeparator /> : null}
              <DropdownMenuRadioItem
                className="items-start"
                data-testid={`presence-status-${option.status}`}
                value={option.status}
              >
                <span className="flex flex-col gap-0.5">
                  <span className="flex items-center gap-2 text-sm">
                    <PresenceDot status={option.status} />
                    {option.label}
                  </span>
                  <span className="text-2xs text-muted-foreground">
                    {option.hint}
                  </span>
                </span>
              </DropdownMenuRadioItem>
            </div>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
