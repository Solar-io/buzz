import type { ProfileDraft } from "./kind0.ts";

/**
 * Validation and dirty-tracking for the own-profile edit form.
 *
 * Kept out of the component so it can be tested without a DOM, and so the
 * "can I press Save" rule has exactly one definition — the button, the
 * keyboard submit path, and the tests all read this.
 */

/**
 * Display names longer than this are refused. Not a protocol limit: it is the
 * width past which the name stops fitting a timeline row or a sidebar entry
 * and starts truncating everywhere it appears.
 */
export const MAX_DISPLAY_NAME_LENGTH = 64;

/** Bio length ceiling — a card blurb, not a document. */
export const MAX_ABOUT_LENGTH = 512;

export interface ProfileFormErrors {
  displayName?: string;
  about?: string;
}

export interface ProfileFormValidation {
  errors: ProfileFormErrors;
  valid: boolean;
}

/**
 * Validate a draft.
 *
 * The display name is required: clearing it would publish a profile whose
 * only identity is a hex key, which reads as a *different, anonymous* person
 * everywhere the client falls back to `truncatePubkey`. Newlines are refused
 * for the same reason a name is one line everywhere it renders.
 *
 * Lengths are measured on the trimmed value, because trimming is what
 * `serializeProfileContent` publishes.
 */
export function validateProfileForm(
  draft: ProfileDraft,
): ProfileFormValidation {
  const errors: ProfileFormErrors = {};
  const displayName = draft.displayName.trim();
  const about = draft.about.trim();

  if (displayName.length === 0) {
    errors.displayName = "Add a display name.";
  } else if (displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    errors.displayName = `Keep it under ${MAX_DISPLAY_NAME_LENGTH} characters.`;
  } else if (/[\r\n]/.test(displayName)) {
    errors.displayName = "A display name has to be a single line.";
  }

  if (about.length > MAX_ABOUT_LENGTH) {
    errors.about = `Keep it under ${MAX_ABOUT_LENGTH} characters.`;
  }

  return { errors, valid: Object.keys(errors).length === 0 };
}

/**
 * Has the draft actually changed?
 *
 * Compared on trimmed values, so adding a trailing space does not arm Save
 * for a publish that would produce byte-identical content — a kind-0 publish
 * is a replaceable-event write every other client re-renders from.
 */
export function profileDraftDirty(
  draft: ProfileDraft,
  initial: ProfileDraft,
): boolean {
  return (
    draft.displayName.trim() !== initial.displayName.trim() ||
    draft.about.trim() !== initial.about.trim() ||
    draft.picture.trim() !== initial.picture.trim()
  );
}

/** Save is live only for a valid draft that differs from what is published. */
export function canSubmitProfileDraft(
  draft: ProfileDraft,
  initial: ProfileDraft,
): boolean {
  return validateProfileForm(draft).valid && profileDraftDirty(draft, initial);
}
