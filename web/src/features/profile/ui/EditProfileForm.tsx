import { ImagePlus, Trash2 } from "lucide-react";
import { useId, useRef, useState } from "react";
import { toast } from "sonner";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { uploadBlob } from "@/shared/api/blossom";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Spinner } from "@/shared/ui/spinner";
import { Textarea } from "@/shared/ui/textarea";
import { publishProfileMetadata } from "../hooks.ts";
import type { ProfileDraft } from "../lib/kind0.ts";
import {
  MAX_ABOUT_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  canSubmitProfileDraft,
  validateProfileForm,
} from "../lib/profileForm.ts";
import { ProfileAvatar } from "./ProfileAvatar.tsx";

/** MIME types the picker offers and the handler accepts for an avatar. */
const AVATAR_ACCEPT = "image/png,image/jpeg,image/gif,image/webp";

/**
 * Own-profile editing: display name, bio, avatar.
 *
 * Publishing is a kind-0 replaceable event, signed and published through the
 * same path as a channel message (`signNostrEvent` → `session.publish`). The
 * avatar goes to Blossom first and only its returned URL is written into the
 * event — the relay stores the bytes, kind 0 stores a pointer.
 *
 * `initial` is the *published* state, not a draft snapshot: Save stays
 * disabled until the form actually differs from it, so a user who opens the
 * editor and closes it cannot accidentally republish identical metadata.
 */
export function EditProfileForm({
  pubkey,
  initial,
  previousContent,
  onSaved,
  onCancel,
}: {
  pubkey: string;
  initial: ProfileDraft;
  /** Raw kind-0 content being edited — merged into, never replaced. */
  previousContent: string | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { session } = useRelaySession();
  // Explicit ids rather than label-wrapping: `Input`/`Textarea` render their
  // own element, so a wrapping <label> has no control the linter (or a screen
  // reader walking the accessibility tree) can associate it with.
  const fieldId = useId();
  const displayNameId = `${fieldId}-display-name`;
  const aboutId = `${fieldId}-about`;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<ProfileDraft>(initial);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  // Errors show only after a field has been touched or a save attempted, so
  // an untouched form does not open shouting "Add a display name."
  const [showErrors, setShowErrors] = useState(false);

  const { errors } = validateProfileForm(draft);
  const canSave = canSubmitProfileDraft(draft, initial);
  const busy = saving || uploading;

  const pickAvatar = async (file: File) => {
    setUploading(true);
    try {
      const descriptor = await uploadBlob(file);
      if (!descriptor.mime_type.startsWith("image/")) {
        // The picker's MIME is client-supplied; trust the server's sniff.
        toast.error("Choose a PNG, JPG, GIF, or WebP image.");
        return;
      }
      setDraft((current) => ({ ...current, picture: descriptor.url }));
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not upload that image.",
      );
    } finally {
      setUploading(false);
    }
  };

  const save = async () => {
    setShowErrors(true);
    if (!canSave || busy) {
      return;
    }
    setSaving(true);
    try {
      const result = await publishProfileMetadata(session, {
        draft,
        previousContent,
      });
      if (result.ok) {
        toast.success("Profile updated");
        onSaved();
      } else {
        toast.error(result.message || "The relay rejected the update.");
      }
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not publish the update.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-4"
      data-testid="edit-profile-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="flex items-center gap-4">
        <ProfileAvatar
          className="h-16 w-16 text-base"
          label={draft.displayName.trim() || pubkey}
          picture={draft.picture}
          testId="edit-profile-avatar"
        />
        <div className="flex flex-wrap gap-2">
          <input
            accept={AVATAR_ACCEPT}
            className="hidden"
            data-testid="edit-profile-avatar-input"
            onChange={(event) => {
              const file = event.target.files?.[0];
              // Reset first: picking the same file twice must re-fire change.
              event.target.value = "";
              if (file) {
                void pickAvatar(file);
              }
            }}
            ref={fileInputRef}
            type="file"
          />
          <Button
            data-testid="edit-profile-avatar-pick"
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
            size="sm"
            type="button"
            variant="outline"
          >
            {uploading ? (
              <Spinner aria-hidden className="h-3.5 w-3.5 border-2" />
            ) : (
              <ImagePlus aria-hidden />
            )}
            {draft.picture ? "Replace photo" : "Upload photo"}
          </Button>
          {draft.picture && (
            <Button
              data-testid="edit-profile-avatar-clear"
              disabled={busy}
              onClick={() =>
                setDraft((current) => ({ ...current, picture: "" }))
              }
              size="sm"
              type="button"
              variant="ghost"
            >
              <Trash2 aria-hidden />
              Remove
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label
          className="text-xs font-medium text-muted-foreground"
          htmlFor={displayNameId}
        >
          Display name
        </label>
        <Input
          data-testid="edit-profile-display-name"
          id={displayNameId}
          maxLength={MAX_DISPLAY_NAME_LENGTH}
          onBlur={() => setShowErrors(true)}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              displayName: event.target.value,
            }))
          }
          placeholder="How you appear in channels"
          spellCheck
          value={draft.displayName}
        />
        {showErrors && errors.displayName && (
          <span
            className="text-2xs text-destructive"
            data-testid="edit-profile-display-name-error"
          >
            {errors.displayName}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <label
          className="text-xs font-medium text-muted-foreground"
          htmlFor={aboutId}
        >
          About
        </label>
        <Textarea
          data-testid="edit-profile-about"
          id={aboutId}
          maxLength={MAX_ABOUT_LENGTH}
          onChange={(event) =>
            setDraft((current) => ({ ...current, about: event.target.value }))
          }
          placeholder="A line or two about you"
          rows={3}
          spellCheck
          value={draft.about}
        />
        <span className="self-end text-2xs text-muted-foreground/70">
          {draft.about.trim().length}/{MAX_ABOUT_LENGTH}
        </span>
      </div>

      <div className="flex justify-end gap-2">
        <Button
          disabled={busy}
          onClick={onCancel}
          size="sm"
          type="button"
          variant="ghost"
        >
          Cancel
        </Button>
        <Button
          data-testid="edit-profile-save"
          disabled={!canSave || busy}
          size="sm"
          type="submit"
        >
          {saving && <Spinner aria-hidden className="h-3.5 w-3.5 border-2" />}
          Save profile
        </Button>
      </div>
    </form>
  );
}
