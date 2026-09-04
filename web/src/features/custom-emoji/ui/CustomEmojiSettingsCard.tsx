import { ImagePlus, Pencil, Trash2, X } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";

import { uploadBlob } from "@/shared/api/blossom";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";

import {
  useCustomEmoji,
  useEditOwnCustomEmoji,
  useOwnCustomEmojiQuery,
} from "../hooks";
import { normalizeShortcode, type CustomEmoji } from "../lib/customEmoji.ts";
import { suggestShortcodeFromFilename } from "../lib/ownEmojiSet.ts";
import { CustomEmojiImage } from "./CustomEmojiImage";

/**
 * Custom emoji management — the web counterpart of the desktop's
 * `CustomEmojiSettingsCard`, and the surface web has been missing entirely:
 * the browser client renders kind:30030 emoji everywhere (messages,
 * reactions, the picker) but offered no way to add one.
 *
 * Every member owns their own kind:30030 set. Adding, renaming and removing
 * all republish MY set and nothing else, so this card edits "My emoji" and
 * shows the community palette — the union of everyone's sets — as read-only
 * below it. A member genuinely cannot remove someone else's emoji, and a
 * control that pretended otherwise would fail at the relay.
 *
 * Rename is the one operation the desktop does not have. On the wire it is
 * not a new operation: the same republish with one entry's shortcode changed
 * (see `renameOwnEmoji`).
 *
 * The upload reuses the composer's uploader — `uploadBlob` in
 * `shared/api/blossom.ts`, the same BUD-02 PUT with real XHR progress that
 * the paperclip and screenshot-paste paths use. Nothing about emoji needs a
 * second uploader, and a second one would be a second place for the relay's
 * size limits and auth header to drift.
 */

type PendingUpload = { url: string; filename: string };

/** One row in a list of emoji: image, shortcode, and whatever actions apply. */
function EmojiRow({
  actions,
  emoji,
}: {
  actions?: React.ReactNode;
  emoji: CustomEmoji;
}) {
  return (
    <li className="flex items-center gap-3 py-2" data-testid="custom-emoji-row">
      <CustomEmojiImage
        className="h-6 w-6 shrink-0"
        shortcode={emoji.shortcode}
        url={emoji.url}
      />
      <span className="min-w-0 flex-1 truncate text-sm">
        :{emoji.shortcode}:
      </span>
      {actions}
    </li>
  );
}

/** Inline rename form, shown in place of one of my rows. */
function RenameRow({
  emoji,
  onCancel,
  onSubmit,
  pending,
}: {
  emoji: CustomEmoji;
  onCancel: () => void;
  onSubmit: (next: string) => void;
  pending: boolean;
}) {
  const [name, setName] = useState(emoji.shortcode);
  const normalized = normalizeShortcode(name);
  return (
    <li className="py-2">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (normalized && normalized !== emoji.shortcode)
            onSubmit(normalized);
        }}
      >
        <CustomEmojiImage
          className="h-6 w-6 shrink-0"
          shortcode={emoji.shortcode}
          url={emoji.url}
        />
        <Input
          aria-label={`New name for :${emoji.shortcode}:`}
          autoCapitalize="none"
          autoCorrect="off"
          autoFocus
          className="h-8 w-40 flex-1"
          data-testid="custom-emoji-rename-input"
          onChange={(event) => setName(event.target.value)}
          spellCheck={false}
          value={name}
        />
        <Button
          data-testid="custom-emoji-rename-save"
          disabled={
            pending || normalized === null || normalized === emoji.shortcode
          }
          size="sm"
          type="submit"
        >
          {pending ? "Saving…" : "Rename"}
        </Button>
        <Button onClick={onCancel} size="sm" type="button" variant="ghost">
          <X aria-hidden className="size-4" />
          <span className="sr-only">Cancel rename</span>
        </Button>
      </form>
      {name.trim().length > 0 && normalized === null ? (
        <p className="mt-1 text-xs text-destructive">
          Use only letters, numbers, hyphen, or underscore.
        </p>
      ) : null}
    </li>
  );
}

export function CustomEmojiSettingsCard() {
  const { data: own = [], isLoading: ownLoading } = useOwnCustomEmojiQuery();
  const community = useCustomEmoji();
  const edit = useEditOwnCustomEmoji();

  const [name, setName] = useState("");
  const [pendingUpload, setPendingUpload] = useState<PendingUpload | null>(
    null,
  );
  const [uploading, setUploading] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);

  const normalized = normalizeShortcode(name);
  const nameInvalid = name.trim().length > 0 && normalized === null;
  const ownDuplicate =
    normalized !== null && own.some((entry) => entry.shortcode === normalized);
  const canSubmit =
    pendingUpload !== null &&
    normalized !== null &&
    !uploading &&
    !edit.isPending;

  const onPickFile = useCallback(async (file: File) => {
    if (!file.type.startsWith("image/")) {
      toast.error("Choose an image file for custom emoji.");
      return;
    }
    setUploading(true);
    try {
      const descriptor = await uploadBlob(file);
      setPendingUpload({ url: descriptor.url, filename: file.name });
      const suggested = suggestShortcodeFromFilename(file.name);
      setName((current) =>
        current.trim().length === 0 && suggested ? suggested : current,
      );
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to upload the emoji image.",
      );
    } finally {
      setUploading(false);
    }
  }, []);

  const run = useCallback(
    async (
      variables: Parameters<typeof edit.mutateAsync>[0],
      success: (shortcode: string) => string,
    ) => {
      try {
        const shortcode = await edit.mutateAsync(variables);
        toast.success(success(shortcode));
        return true;
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "That change did not save.",
        );
        return false;
      }
    },
    [edit],
  );

  const onAdd = async () => {
    if (!canSubmit || normalized === null || pendingUpload === null) return;
    const added = await run(
      { type: "add", shortcode: normalized, url: pendingUpload.url },
      (shortcode) => `Added :${shortcode}:`,
    );
    if (added) {
      setName("");
      setPendingUpload(null);
    }
  };

  const ownShortcodes = new Set(own.map((entry) => entry.shortcode));
  const othersEmoji = community.filter(
    (entry) => !ownShortcodes.has(entry.shortcode),
  );

  return (
    <section
      className="space-y-3 rounded-lg border border-border bg-card p-4"
      data-testid="custom-emoji-card"
    >
      <div>
        <h2 className="font-medium">Custom emoji</h2>
        <p className="text-sm text-muted-foreground">
          Add your own emoji for everyone on this relay to use. Type{" "}
          <code className="rounded bg-muted px-1">:name:</code> in a message or
          a reaction.
        </p>
      </div>

      <form
        className="space-y-2 rounded-md border border-border p-3"
        onSubmit={(event) => {
          event.preventDefault();
          void onAdd();
        }}
      >
        <div className="flex items-center gap-3">
          <span className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-background">
            {pendingUpload ? (
              <CustomEmojiImage
                className="h-10 w-10"
                shortcode={normalized ?? "preview"}
                url={pendingUpload.url}
              />
            ) : (
              <ImagePlus aria-hidden className="size-5 text-muted-foreground" />
            )}
          </span>
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-sm font-medium">Upload an image</p>
            <p className="text-xs text-muted-foreground">
              {pendingUpload
                ? pendingUpload.filename
                : "Square images work best. GIF, PNG, JPEG and WebP are supported."}
            </p>
          </div>
          <Button asChild disabled={uploading} size="sm" variant="outline">
            <label>
              {uploading
                ? "Uploading…"
                : pendingUpload
                  ? "Choose another"
                  : "Choose image"}
              <input
                accept="image/png,image/jpeg,image/gif,image/webp"
                className="sr-only"
                data-testid="custom-emoji-file"
                disabled={uploading}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  // Clear the input so re-picking the same file re-fires.
                  event.target.value = "";
                  if (file) void onPickFile(file);
                }}
                type="file"
              />
            </label>
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label
            className="text-sm font-medium"
            htmlFor="custom-emoji-name-input"
          >
            Name
          </label>
          <Input
            autoCapitalize="none"
            autoCorrect="off"
            className="h-9 w-48 flex-1"
            data-testid="custom-emoji-name-input"
            id="custom-emoji-name-input"
            onChange={(event) => setName(event.target.value)}
            placeholder="party-parrot"
            spellCheck={false}
            value={name}
          />
          <Button
            data-testid="custom-emoji-add"
            disabled={!canSubmit}
            type="submit"
          >
            {edit.isPending ? "Saving…" : "Add emoji"}
          </Button>
        </div>
        {nameInvalid ? (
          <p className="text-xs text-destructive">
            Use only letters, numbers, hyphen, or underscore.
          </p>
        ) : ownDuplicate ? (
          <p className="text-xs text-muted-foreground">
            You already have :{normalized}: — saving replaces its image.
          </p>
        ) : pendingUpload === null ? (
          <p className="text-xs text-muted-foreground">
            Choose an image first; the name is suggested from the filename.
          </p>
        ) : null}
      </form>

      <div data-testid="custom-emoji-mine">
        <h3 className="text-sm font-medium">
          My emoji{own.length > 0 ? ` (${own.length})` : ""}
        </h3>
        {ownLoading ? (
          <p className="py-2 text-sm text-muted-foreground">Loading…</p>
        ) : own.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">
            You have not added any emoji yet.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {own.map((emoji) =>
              renaming === emoji.shortcode ? (
                <RenameRow
                  emoji={emoji}
                  key={emoji.shortcode}
                  onCancel={() => setRenaming(null)}
                  onSubmit={(next) => {
                    void run(
                      { type: "rename", from: emoji.shortcode, to: next },
                      (shortcode) =>
                        `Renamed :${emoji.shortcode}: to :${shortcode}:`,
                    ).then((ok) => {
                      if (ok) setRenaming(null);
                    });
                  }}
                  pending={edit.isPending}
                />
              ) : (
                <EmojiRow
                  actions={
                    <span className="flex shrink-0 items-center gap-1">
                      <Button
                        aria-label={`Rename :${emoji.shortcode}:`}
                        data-testid="custom-emoji-rename"
                        disabled={edit.isPending}
                        onClick={() => setRenaming(emoji.shortcode)}
                        size="sm"
                        variant="ghost"
                      >
                        <Pencil aria-hidden className="size-4" />
                      </Button>
                      <Button
                        aria-label={`Remove :${emoji.shortcode}:`}
                        data-testid="custom-emoji-remove"
                        disabled={edit.isPending}
                        onClick={() => {
                          void run(
                            { type: "remove", shortcode: emoji.shortcode },
                            (shortcode) => `Removed :${shortcode}:`,
                          );
                        }}
                        size="sm"
                        variant="ghost"
                      >
                        <Trash2 aria-hidden className="size-4" />
                      </Button>
                    </span>
                  }
                  emoji={emoji}
                  key={emoji.shortcode}
                />
              ),
            )}
          </ul>
        )}
      </div>

      {othersEmoji.length > 0 ? (
        <div data-testid="custom-emoji-community">
          <h3 className="text-sm font-medium">
            Community emoji ({othersEmoji.length})
          </h3>
          <p className="text-xs text-muted-foreground">
            Added by other members. You can use these; only their owner can
            change them.
          </p>
          <ul className="divide-y divide-border">
            {othersEmoji.map((emoji) => (
              <EmojiRow emoji={emoji} key={emoji.shortcode} />
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
