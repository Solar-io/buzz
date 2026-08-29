import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useChannels } from "@/features/channels/useChannels";
import { useAuth } from "@/features/auth/ui/AuthProvider";
import { LoginPage } from "@/features/auth/ui/LoginPage";
import { AppShell } from "@/shared/layout/AppShell";
import { cn } from "@/shared/lib/cn";

/**
 * The app lives at /repos — the one browser-servable path the relay's
 * public-bundle fallback guarantees on the stock image (with the git web GUI
 * flag on). Everything else is client-side navigation from here.
 */
export const Route = createFileRoute("/repos")({
  validateSearch: (search: Record<string, unknown>): { c?: string } => ({
    c: typeof search.c === "string" ? search.c : undefined,
  }),
  component: AppRoute,
});

function AppRoute() {
  const { canSign } = useAuth();
  if (!canSign) {
    return <LoginPage />;
  }
  return <ChannelBrowser />;
}

function ChannelBrowser() {
  const { channels, connected } = useChannels();
  const navigate = useNavigate({ from: "/repos" });
  const selectedId = Route.useSearch({ select: (s) => s.c });
  const current = channels.find((channel) => channel.id === selectedId) ?? null;

  const sidebar = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="px-1 font-semibold">Channels</span>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "inline-block h-2 w-2 rounded-full",
              connected ? "bg-emerald-500" : "bg-muted-foreground/40",
            )}
            title={connected ? "Connected" : "Connecting…"}
          />
          <Link
            to="/repos/settings"
            className="rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-accent"
          >
            Settings
          </Link>
        </div>
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {channels.length === 0 && (
          <p className="px-2 py-4 text-sm text-muted-foreground">
            {connected
              ? "No channels visible yet."
              : "Connecting to the relay…"}
          </p>
        )}
        <ul className="space-y-0.5">
          {channels.map((channel) => (
            <li key={channel.id}>
              <button
                type="button"
                className={cn(
                  "w-full truncate rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
                  channel.id === selectedId && "bg-accent font-medium",
                )}
                onClick={() =>
                  void navigate({
                    to: "/repos",
                    search: { c: channel.id },
                  })
                }
              >
                {channel.name}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div className="border-t border-border p-2">
        <Link
          to="/repos/browse"
          className="block rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent"
        >
          Browse repositories
        </Link>
      </div>
    </div>
  );

  return (
    <AppShell sidebar={sidebar}>
      {current ? (
        <section className="flex h-full flex-col">
          <div className="border-b border-border px-4 py-3">
            <h1 className="text-lg font-semibold">{current.name}</h1>
            {current.about && (
              <p className="text-sm text-muted-foreground">{current.about}</p>
            )}
          </div>
          <div className="flex flex-1 items-center justify-center p-8">
            <p className="max-w-sm text-center text-sm text-muted-foreground">
              Channel timelines, threads, mentions, and sending arrive in
              Phase&nbsp;1. This screen proves the signed relay session works:
              the list on the left is live channel metadata from the relay.
            </p>
          </div>
        </section>
      ) : (
        <div className="flex h-full items-center justify-center p-8">
          <p className="text-sm text-muted-foreground">
            Pick a channel to get started.
          </p>
        </div>
      )}
    </AppShell>
  );
}
