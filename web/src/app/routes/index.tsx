import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Button } from "@/shared/ui/button";
import { AppShell } from "@/shared/layout/AppShell";
import { useAuth } from "@/features/auth/ui/AuthProvider";
import { useChannels } from "@/features/channels/useChannels";
import { cn } from "@/shared/lib/cn";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  const { canSign } = useAuth();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<string | null>(null);

  if (!canSign) {
    void navigate({ to: "/login" });
    return null;
  }

  return (
    <ChannelBrowser selected={selected} onSelect={(id) => setSelected(id)} />
  );
}

function ChannelBrowser({
  selected,
  onSelect,
}: {
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const { channels, connected } = useChannels();
  const current = channels.find((channel) => channel.id === selected) ?? null;

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
          <Button asChild variant="ghost" size="sm">
            <Link to="/settings">Settings</Link>
          </Button>
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
                  channel.id === selected && "bg-accent font-medium",
                )}
                onClick={() => onSelect(channel.id)}
              >
                {channel.name}
              </button>
            </li>
          ))}
        </ul>
      </nav>
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
