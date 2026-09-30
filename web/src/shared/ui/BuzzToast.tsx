import { AlertCircle, Bell, Check, GitBranch, LogOut, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/shared/lib/cn";
import { HexAvatar } from "./HexAvatar";
import type { ToastIcon, ToastSpec } from "./notify.ts";

/**
 * One redesign toast (Toasts.dc.html): an elevated card with a state icon or
 * the sender's mark, a bold lead, a mono meta line, up to two lines of body,
 * its actions, a close, and — for the self-dismissing variants — a timer line
 * draining over the toast's own duration.
 */
export function BuzzToast({
  spec,
  toastId,
}: {
  spec: ToastSpec;
  toastId: string | number;
}) {
  const dismiss = () => toast.dismiss(toastId);
  const inline = spec.variant === "agentDone";
  const actions = (
    <div className={cn("flex gap-1.5", !inline && "mt-2")}>
      {spec.actions.map((action) => (
        <button
          key={action.label}
          type="button"
          onClick={() => {
            action.onClick();
            dismiss();
          }}
          className={cn(
            "h-6.5 rounded-[7px] px-2.5 text-xs font-semibold transition-colors",
            action.primary
              ? "border border-primary bg-primary text-primary-foreground hover:opacity-90"
              : action === spec.actions[0] || spec.variant === "sendError"
                ? "border border-input bg-transparent text-foreground hover:bg-accent"
                : "border-0 bg-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
  return (
    <div
      role={spec.role}
      data-testid={`buzz-toast-${spec.variant}`}
      className="w-[min(var(--width,348px),calc(100vw-2rem))] overflow-hidden rounded-xl border border-input bg-popover text-popover-foreground shadow-elev"
    >
      <div className="flex gap-2.5 px-3 py-2.75">
        <ToastMark icon={spec.icon} />
        <div className="min-w-0 flex-1">
          <div className="text-sidebar-meta leading-snug">
            <b className="font-semibold">{spec.lead}</b>
            {spec.rest ? <> {spec.rest}</> : null}
          </div>
          {spec.meta ? (
            <div
              className={cn(
                "mt-px font-mono text-2xs text-muted-foreground",
                spec.variant === "sendError"
                  ? "whitespace-pre-wrap break-words"
                  : "truncate",
              )}
            >
              {spec.meta}
            </div>
          ) : null}
          {spec.body ? (
            <p className="mt-0.5 line-clamp-2 text-xs text-ink-2">
              {spec.ai ? (
                <span className="mr-1 rounded-[3px] bg-chip px-1 font-mono text-badge font-semibold text-muted-foreground">
                  AI
                </span>
              ) : null}
              {spec.body}
            </p>
          ) : null}
          {inline ? null : actions}
        </div>
        {inline ? <div className="self-center">{actions}</div> : null}
        <button
          type="button"
          aria-label="Dismiss"
          onClick={dismiss}
          className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X aria-hidden className="size-3.25" />
        </button>
      </div>
      {spec.timer && Number.isFinite(spec.duration) ? (
        <div className="h-0.5 bg-border">
          <span
            className={cn(
              "buzz-toast-timer block h-full",
              spec.variant === "agentDone" ? "bg-leaf" : "bg-muted-foreground",
            )}
            style={{ animationDuration: `${spec.duration}ms` }}
          />
        </div>
      ) : null}
    </div>
  );
}

function ToastMark({ icon }: { icon: ToastIcon }) {
  if (icon.kind === "avatar") {
    return icon.agent ? (
      <HexAvatar
        label={icon.label}
        seed={icon.seed}
        size={22}
        ring={icon.ring}
      />
    ) : (
      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-human text-3xs font-semibold text-human-ink">
        {icon.label.slice(0, 1).toUpperCase()}
      </span>
    );
  }
  if (icon.kind === "workflow") {
    // The need-ringed hex every "waiting on you" mark wears, with the
    // workflow glyph where an agent's initials would be.
    return (
      <span
        aria-hidden
        className="buzz-hex grid shrink-0 place-items-center bg-need"
        style={{ width: 22, height: 22 * 1.155 }}
      >
        <span
          className="buzz-hex grid place-items-center bg-card text-ink-2"
          style={{ width: 18, height: 18 * 1.155 }}
        >
          <GitBranch className="size-2.75" strokeWidth={2.2} />
        </span>
      </span>
    );
  }
  const Icon =
    icon.kind === "done"
      ? Check
      : icon.kind === "error"
        ? AlertCircle
        : icon.kind === "left"
          ? LogOut
          : Bell;
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded-full",
        icon.kind === "done"
          ? "bg-leaf-soft text-leaf-ink"
          : icon.kind === "left"
            ? "bg-honey-soft text-honey-ink"
            : "bg-coral-soft text-coral-ink",
      )}
    >
      <Icon className="size-3.5" strokeWidth={icon.kind === "done" ? 2.4 : 2} />
    </span>
  );
}
