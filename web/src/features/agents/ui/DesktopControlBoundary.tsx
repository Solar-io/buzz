import type { ReactNode } from "react";

/** Keep published values visible while native form controls are locked. */
export function DesktopControlBoundary({
  locked,
  offline,
  reason,
  children,
}: {
  locked: boolean;
  offline: boolean;
  reason: string | null;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-3">
      {locked && (
        <p
          role="status"
          className={
            offline
              ? "rounded-md border border-coral/30 bg-coral/10 p-3 text-sm text-coral"
              : "rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground"
          }
        >
          {offline
            ? "Buzz Desktop is offline. These are the settings it last published. "
            : ""}
          {reason}
        </p>
      )}
      <fieldset
        disabled={locked}
        title={reason ?? undefined}
        className="min-w-0 disabled:opacity-60"
      >
        {children}
      </fieldset>
    </div>
  );
}
