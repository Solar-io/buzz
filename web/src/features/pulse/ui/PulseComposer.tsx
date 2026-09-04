import { useState } from "react";
import { toast } from "sonner";

import type { Profile } from "@/features/channels/hooks";
import { AuthorAvatar } from "@/features/channels/ui/AuthorAvatar";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { Button } from "@/shared/ui/button";
import { Textarea } from "@/shared/ui/textarea";

/**
 * The "What's on your mind?" box at the top of every note feed.
 *
 * Publishing is disabled — with the reason on screen — when there is no
 * signed-in key, rather than showing a live-looking box whose Post button
 * fails at the relay.
 */
export function PulseComposer({
  onPublish,
  profile,
  selfPubkey,
}: {
  onPublish: (content: string) => Promise<unknown>;
  profile: Profile | undefined;
  selfPubkey: string | null;
}) {
  const [content, setContent] = useState("");
  const [posting, setPosting] = useState(false);

  const label =
    profile?.displayName?.trim() ||
    profile?.name?.trim() ||
    (selfPubkey ? truncatePubkey(selfPubkey) : "You");

  const submit = async () => {
    const body = content.trim();
    if (!body || posting) {
      return;
    }
    setPosting(true);
    try {
      await onPublish(body);
      setContent("");
      toast.success("Note posted");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to post the note",
      );
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className="rounded-2xl border border-border/50 bg-background/70 p-3">
      <div className="flex items-center gap-2">
        {selfPubkey ? (
          <AuthorAvatar
            label={label}
            picture={profile?.avatar}
            pubkey={selfPubkey}
            size="sm"
          />
        ) : null}
        <span className="truncate text-sm font-medium text-foreground">
          {label}
        </span>
      </div>
      <Textarea
        aria-label="New note"
        className="mt-2 min-h-16 resize-none border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0"
        data-testid="pulse-composer-input"
        disabled={!selfPubkey}
        onChange={(event) => setContent(event.target.value)}
        placeholder={
          selfPubkey
            ? "What's on your mind?"
            : "Sign in with a key to post a note."
        }
        value={content}
      />
      <div className="mt-2 flex justify-end">
        <Button
          data-testid="pulse-composer-post"
          disabled={!selfPubkey || posting || content.trim().length === 0}
          onClick={() => void submit()}
          size="sm"
          type="button"
        >
          {posting ? "Posting…" : "Post"}
        </Button>
      </div>
    </div>
  );
}
