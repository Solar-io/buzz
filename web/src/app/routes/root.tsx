import { Outlet, createRootRoute } from "@tanstack/react-router";

export const Route = createRootRoute({
  component: RootLayout,
  // Diagnostic (2026-08-31): the router's default ErrorComponent shows only
  // the message ("Cannot access 'I' before initialization") with no stack,
  // which made an intermittent owner-only render crash undiagnosable. This
  // boundary keeps the app readable AND surfaces the full stack so the next
  // occurrence names the throwing frame (decode with the local sourcemap).
  errorComponent: RouteError,
});

function RootLayout() {
  return (
    <div className="flex min-h-dvh flex-col">
      <main className="flex flex-1 flex-col">
        <Outlet />
      </main>
    </div>
  );
}

function RouteError({ error }: { error: unknown }) {
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? (error.stack ?? "") : "";
  console.error("[buzz-web] route render error:", error);
  return (
    <div className="min-h-dvh bg-background p-6 text-foreground">
      <div className="mx-auto max-w-3xl space-y-3">
        <h1 className="text-lg font-semibold">Something went wrong</h1>
        <p className="text-sm text-muted-foreground">
          The app hit an error while rendering. The details below are for a bug
          report — select and copy them whole.
        </p>
        <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs leading-relaxed">
          {`${name}: ${message}\n\n${stack}`}
        </pre>
        <button
          type="button"
          className="rounded-md border px-3 py-1.5 text-sm"
          onClick={() => window.location.reload()}
        >
          Reload
        </button>
      </div>
    </div>
  );
}
