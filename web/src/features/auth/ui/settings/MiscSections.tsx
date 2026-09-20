/**
 * The small settings sections, extracted from the original single-file page so
 * it can keep growing without crossing the 1000-line ceiling.
 *
 * Behaviour is unchanged from the versions that lived inline; only the file
 * boundary moved.
 */

import { useState } from "react";
import { Link } from "@tanstack/react-router";

import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import {
  getConfiguredFilesUrl,
  setConfiguredFilesUrl,
} from "@/features/files/filesConfig";

/*
 * Notifications has no entry point here any more: the settings redesign
 * promotes it to a real pane, and the dialog's controls live in
 * `NotificationSettingsPanel` (features/notifications) — rendered inline,
 * still prompting only from the switch's own change event.
 */

export function AgentsSection() {
  return (
    <section className="space-y-2 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <h2 className="font-medium">Agents</h2>
        <Button asChild variant="ghost" size="sm">
          <Link to="/repos/agents">Manage agents</Link>
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Create agents and change their settings — drafts are reviewed in Buzz
        Desktop.
      </p>
    </section>
  );
}

/**
 * File-manager URL — the one External-tier setting. Shows the effective URL
 * (browser override, else the build default), lets the user change or clear
 * it. Changing it here is the supported path once a URL is already set.
 */
export function FilesUrlSection() {
  const [url, setUrl] = useState(() => getConfiguredFilesUrl());
  const [entry, setEntry] = useState("");
  const effective = url || "(not configured — Files will ask)";
  return (
    <section className="space-y-2 rounded-lg border border-border bg-card p-4">
      <h2 className="font-medium">Files</h2>
      <p className="text-sm text-muted-foreground">
        The web file manager embedded by the Files panel. Current:{" "}
        <span className="break-all font-mono text-xs">{effective}</span>
      </p>
      <div className="flex gap-2">
        <Input
          value={entry}
          onChange={(event) => setEntry(event.target.value)}
          placeholder="https://files.your-network/"
          aria-label="File manager URL"
        />
        <Button
          size="sm"
          disabled={!entry.trim()}
          onClick={() => {
            setConfiguredFilesUrl(entry.trim());
            setUrl(entry.trim());
            setEntry("");
          }}
        >
          Save
        </Button>
        {url ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setConfiguredFilesUrl(null);
              setUrl("");
            }}
          >
            Clear
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground/70">
        Saved on this browser; a build-time default may apply when cleared.
      </p>
    </section>
  );
}

/** Profile entry point — the kind:0 editor lives in the profile feature. */
export function ProfileSection({ onOpen }: { onOpen: () => void }) {
  return (
    <section className="space-y-2 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-4">
        <h2 className="font-medium">Profile</h2>
        <Button onClick={onOpen} size="sm" variant="ghost">
          Edit profile
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Your display name, picture, and bio — published as your kind:0 and seen
        by everyone on this relay.
      </p>
    </section>
  );
}
