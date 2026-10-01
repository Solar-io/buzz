import { LogIn, Power, RotateCcw, ShieldAlert, WifiOff } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/shared/lib/cn";
import type { TermState } from "../emulator/protocol.ts";

/** Everything the page can be showing, the emulator's states plus the gate's. */
export type PageState =
  | TermState
  | "checking"
  /** hatch did not answer `/api/me` at all. */
  | "unreachable";

const PILL: Record<PageState, { label: string; dot: string; pulse?: boolean }> =
  {
    checking: { label: "checking", dot: "bg-faint" },
    connecting: { label: "connecting", dot: "bg-work", pulse: true },
    connected: { label: "connected", dot: "bg-leaf" },
    reconnecting: { label: "reconnecting", dot: "bg-work", pulse: true },
    "signed-out": { label: "signed out", dot: "bg-faint" },
    forbidden: { label: "not allowed", dot: "bg-need" },
    disabled: { label: "off", dot: "bg-faint" },
    "at-capacity": { label: "at capacity", dot: "bg-need" },
    "shell-exited": { label: "exited", dot: "bg-faint" },
    failed: { label: "error", dot: "bg-need" },
    unreachable: { label: "offline", dot: "bg-need" },
  };

/** The header's connection pill (Terminal artboard). */
export function ConnectionPill({ state }: { state: PageState }) {
  const pill = PILL[state];
  return (
    <span
      data-testid="terminal-pill"
      data-state={state}
      className="inline-flex h-5.5 shrink-0 items-center gap-1.5 rounded-full bg-chip px-2 font-mono text-2xs text-ink-2"
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full",
          pill.dot,
          pill.pulse && "motion-safe:animate-pulse",
        )}
      />
      {pill.label}
    </span>
  );
}

interface Copy {
  icon: ReactNode;
  title: string;
  body: ReactNode;
  action: string;
}

function disabledBody(reason: string | null): string {
  if (reason === "runtime_file") {
    return "crichton's kill switch is on (terminal.disabled), so no shell can open.";
  }
  if (reason === "env_off") {
    return "crichton's terminal switch (HATCH_TERMINAL_ENABLED) is off.";
  }
  return "crichton has the terminal turned off.";
}

function copyFor(
  state: PageState,
  context: { email: string | null; reason: string | null; host: string },
): Copy | null {
  const icon = "size-5";
  switch (state) {
    case "signed-out":
      return {
        icon: <LogIn aria-hidden className={icon} />,
        title: "Sign in to crichton",
        body: "The terminal has its own sign-in, separate from Buzz. A GitHub window opens and closes itself when you're done.",
        action: "Sign in with GitHub",
      };
    case "forbidden":
      return {
        icon: <ShieldAlert aria-hidden className={icon} />,
        title: "This account can't open crichton",
        body: `${context.email ?? "The account you signed in with"} isn't on crichton's allowlist.`,
        action: "Sign in with another account",
      };
    case "disabled":
      return {
        icon: <Power aria-hidden className={icon} />,
        title: "The terminal is off",
        body: `${disabledBody(context.reason)} Vitals and herdr status keep working.`,
        action: "Check again",
      };
    case "unreachable":
      return {
        icon: <WifiOff aria-hidden className={icon} />,
        title: "crichton isn't answering",
        body: `hatch at ${context.host} didn't respond. It may be restarting.`,
        action: "Try again",
      };
    case "at-capacity":
      return {
        icon: <RotateCcw aria-hidden className={icon} />,
        title: "crichton is at capacity",
        body: "Too many terminals are open, or this one fell behind. Your shell is still running.",
        action: "Reconnect",
      };
    case "shell-exited":
      return {
        icon: <Power aria-hidden className={icon} />,
        title: "The shell exited",
        body: "That session ended. A new shell starts fresh.",
        action: "Start a new shell",
      };
    case "failed":
      return {
        icon: <ShieldAlert aria-hidden className={icon} />,
        title: "The terminal couldn't start",
        body: "hatch couldn't open a shell on crichton.",
        action: "Try again",
      };
    default:
      return null;
  }
}

/**
 * The emulator area's non-terminal states (phase-7.md §8: signed-out,
 * not-authorized, disabled, unreachable, at-capacity, shell-exited, failed),
 * each with its own words and the one action that can fix it. Never a dead
 * black box. `checking` / `connecting` are a quiet line, not a card.
 */
export function TerminalStatus({
  state,
  email,
  reason,
  host,
  onAction,
  overlay,
}: {
  state: PageState;
  email: string | null;
  reason: string | null;
  host: string;
  onAction: () => void;
  /** Over a live (dimmed) emulator rather than in place of one. */
  overlay?: boolean;
}) {
  if (state === "checking" || state === "connecting") {
    return (
      <div
        data-testid="terminal-status"
        data-state={state}
        className={cn(
          "pointer-events-none absolute inset-0 grid place-items-center font-mono text-xs text-term-dim",
        )}
      >
        {state === "checking"
          ? "Checking crichton…"
          : "Opening herdr on crichton…"}
      </div>
    );
  }
  const copy = copyFor(state, { email, reason, host });
  if (!copy) {
    return null;
  }
  return (
    <div
      data-testid="terminal-status"
      data-state={state}
      className={cn(
        "absolute inset-0 grid place-items-center p-6",
        overlay && "bg-term/85 backdrop-blur-[1px]",
      )}
    >
      <section
        aria-labelledby="terminal-status-title"
        aria-live="polite"
        className="flex w-full max-w-[22rem] flex-col items-start gap-3 rounded-xl border border-border bg-card p-5 text-foreground shadow-elev"
      >
        <span className="grid size-9 place-items-center rounded-lg bg-chip text-ink-2">
          {copy.icon}
        </span>
        <div>
          <h2 id="terminal-status-title" className="text-base font-semibold">
            {copy.title}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{copy.body}</p>
        </div>
        <button
          type="button"
          onClick={onAction}
          className="inline-flex h-9 items-center rounded-lg bg-primary px-3.5 text-sm font-semibold text-primary-foreground hover:opacity-90"
        >
          {copy.action}
        </button>
      </section>
    </div>
  );
}
