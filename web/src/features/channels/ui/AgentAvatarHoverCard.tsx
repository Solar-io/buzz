import { useEffect, useRef, useState, type ReactNode } from "react";

import { shouldArmAgentHover } from "@/features/agents/lib/agentConfigCard";
import { useAgentConfigCard } from "@/features/agents/useAgentConfigCard";
import { AgentConfigList } from "@/features/profile/ui/AgentConfigSection";
import { useAnyHover } from "@/shared/lib/useAnyHover";
import {
  DEFAULT_POPOVER_HOVER_OPEN_DELAY_MS,
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/shared/ui/popover";

/**
 * Hover card over an AGENT's avatar showing its model and manually set knobs
 * (effort, context, voice). Owner ask: avatars only — never the name. Wrap
 * only the avatar trigger with this.
 *
 * Inert on touch-only devices (renders `children` untouched); there the tap
 * opens the profile card, whose agent section carries the same rows.
 * Data is fetched per arm (`pointerenter`), never per rendered row, and the
 * 500 ms dwell usually hides the fetch.
 */
export function AgentAvatarHoverCard({
  pubkey,
  label,
  children,
}: {
  pubkey: string;
  label: string;
  children: ReactNode;
}) {
  const anyHover = useAnyHover();
  const [armed, setArmed] = useState(false);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimer = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };
  // Unmount mid-dwell must not fire setOpen on a dead component.
  useEffect(
    () => () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
      }
    },
    [],
  );

  if (!anyHover) {
    return <>{children}</>;
  }
  const disarm = () => {
    clearTimer();
    setArmed(false);
    setOpen(false);
  };
  return (
    <Popover open={open}>
      <PopoverAnchor asChild>
        <span
          className="inline-flex"
          data-testid={`agent-avatar-hover-${pubkey}`}
          onPointerDown={() => {
            // The click belongs to the profile card.
            clearTimer();
            setOpen(false);
          }}
          onPointerEnter={(event) => {
            if (!shouldArmAgentHover(event.pointerType, true)) {
              return;
            }
            setArmed(true);
            clearTimer();
            timer.current = setTimeout(() => {
              timer.current = null;
              setOpen(true);
            }, DEFAULT_POPOVER_HOVER_OPEN_DELAY_MS);
          }}
          onPointerLeave={disarm}
        >
          {children}
        </span>
      </PopoverAnchor>
      {armed && (
        <AgentConfigCardBody label={label} open={open} pubkey={pubkey} />
      )}
    </Popover>
  );
}

function AgentConfigCardBody({
  pubkey,
  label,
  open,
}: {
  pubkey: string;
  label: string;
  open: boolean;
}) {
  const { rows, loading } = useAgentConfigCard(pubkey);
  if (!open) {
    return null;
  }
  return (
    <PopoverContent
      align="start"
      className="pointer-events-none w-72 p-3"
      data-testid="agent-config-card"
      onCloseAutoFocus={(event) => event.preventDefault()}
      onOpenAutoFocus={(event) => event.preventDefault()}
      side="right"
    >
      <div className="flex flex-col gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{label}</p>
          <p className="text-xs text-muted-foreground">Configured on agent</p>
        </div>
        <AgentConfigList loading={loading} rows={rows} />
      </div>
    </PopoverContent>
  );
}
