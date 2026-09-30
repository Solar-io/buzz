import { getInitials } from "@/features/channels/lib/avatar.ts";
import { cn } from "@/shared/lib/cn";

/**
 * Agent and human marks from the redesign canvas (Main.dc.html).
 *
 * Agents are hexagons: an outer hex whose colour says the agent's STATE
 * (work = running, need = waiting on you, idle = quiet, card = a plain cut-out
 * on a surface) around an inner hex in the agent's fixed identity ink.
 * Humans are round, on the `human` token. Initials only — the rows these sit
 * in are dense lists, and a signed media fetch per row is not worth a 16px
 * picture.
 */

export type HexRing = "work" | "need" | "idle" | "card";

const RING: Record<HexRing, string> = {
  work: "bg-work",
  need: "bg-need",
  idle: "bg-idle-ring",
  card: "bg-card",
};

const INKS = 7;

/** Stable identity ink for a pubkey (or any seed). */
export function agentInkClass(seed: string): string {
  let hash = 0;
  for (const character of seed) {
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0;
  }
  return `buzz-agent-ink-${hash % INKS}`;
}

export function HexAvatar({
  label,
  seed,
  size = 20,
  ring = "idle",
  pulse = false,
  className,
}: {
  label: string;
  seed: string;
  /** Outer width in px; the hex is 1.155 × taller. */
  size?: number;
  ring?: HexRing;
  pulse?: boolean;
  className?: string;
}) {
  const inner = Math.max(8, size - (size >= 30 ? 6 : 4));
  return (
    <span
      aria-hidden
      className={cn(
        "buzz-hex grid shrink-0 place-items-center",
        RING[ring],
        pulse && "motion-safe:animate-pulse",
        className,
      )}
      style={{ width: size, height: size * 1.155 }}
    >
      <span
        className={cn(
          "buzz-hex buzz-agent-ink grid place-items-center font-mono font-semibold leading-none",
          agentInkClass(seed),
          size >= 30 ? "text-badge" : "text-3xs",
        )}
        style={{ width: inner, height: inner * 1.155 }}
      >
        {getInitials(label) || "?"}
      </span>
    </span>
  );
}

export function HumanAvatar({
  label,
  size = 20,
  className,
}: {
  label: string;
  size?: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center rounded-full bg-human font-semibold leading-none text-human-ink",
        size >= 30 ? "text-xs" : "text-3xs",
        className,
      )}
      style={{ width: size, height: size }}
    >
      {getInitials(label) || "?"}
    </span>
  );
}

/** A small state hex (no avatar): section markers, badges, row dots. */
export function StateHex({
  tone,
  size = 10,
  pulse = false,
  className,
}: {
  tone: "work" | "need" | "idle";
  size?: number;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "buzz-hex inline-block shrink-0",
        tone === "work"
          ? "bg-work"
          : tone === "need"
            ? "bg-need"
            : "bg-idle-hex",
        pulse && "motion-safe:animate-pulse",
        className,
      )}
      style={{ width: size, height: size * 1.15 }}
    />
  );
}
