import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_ABOUT_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  canSubmitProfileDraft,
  profileDraftDirty,
  validateProfileForm,
} from "./profileForm.ts";

const base = { displayName: "Sam", about: "", picture: "" };

test("the published limits are the ones the form advertises", () => {
  // Hardcoded on purpose. Expressed as `MAX_DISPLAY_NAME_LENGTH` these would
  // move with the constant and pin nothing.
  assert.equal(MAX_DISPLAY_NAME_LENGTH, 64);
  assert.equal(MAX_ABOUT_LENGTH, 512);
});

test("a display name is required", () => {
  const empty = validateProfileForm({ ...base, displayName: "" });
  assert.equal(empty.valid, false);
  assert.equal(empty.errors.displayName, "Add a display name.");

  const blank = validateProfileForm({ ...base, displayName: "   " });
  assert.equal(blank.valid, false, "whitespace is not a name");
});

test("a 64-character display name is accepted and a 65-character one is not", () => {
  const ok = validateProfileForm({ ...base, displayName: "a".repeat(64) });
  assert.equal(ok.valid, true);

  const tooLong = validateProfileForm({ ...base, displayName: "a".repeat(65) });
  assert.equal(tooLong.valid, false);
  assert.equal(tooLong.errors.displayName, "Keep it under 64 characters.");
});

test("length is measured after trimming, because trimming is what gets published", () => {
  const padded = validateProfileForm({
    ...base,
    displayName: `  ${"a".repeat(64)}  `,
  });
  assert.equal(padded.valid, true);
});

test("a display name has to be a single line", () => {
  const multiline = validateProfileForm({
    ...base,
    displayName: "Sam\nGallant",
  });
  assert.equal(multiline.valid, false);
  assert.equal(
    multiline.errors.displayName,
    "A display name has to be a single line.",
  );
});

test("a 512-character bio is accepted and a 513-character one is not", () => {
  assert.equal(
    validateProfileForm({ ...base, about: "b".repeat(512) }).valid,
    true,
  );
  const tooLong = validateProfileForm({ ...base, about: "b".repeat(513) });
  assert.equal(tooLong.valid, false);
  assert.equal(tooLong.errors.about, "Keep it under 512 characters.");
});

test("profileDraftDirty ignores whitespace-only edits", () => {
  assert.equal(profileDraftDirty(base, base), false);
  assert.equal(
    profileDraftDirty({ ...base, displayName: "  Sam  " }, base),
    false,
    "padding a value must not arm a republish of identical content",
  );
  assert.equal(
    profileDraftDirty({ ...base, displayName: "Sammy" }, base),
    true,
  );
});

test("profileDraftDirty notices a bio or an avatar change on its own", () => {
  assert.equal(profileDraftDirty({ ...base, about: "hi" }, base), true);
  assert.equal(
    profileDraftDirty({ ...base, picture: "https://x/y.png" }, base),
    true,
  );
});

test("Save needs BOTH a valid draft and a real change", () => {
  // Four-way, so neither half can be dropped without a failure here.
  assert.equal(canSubmitProfileDraft(base, base), false, "valid but unchanged");
  assert.equal(
    canSubmitProfileDraft({ ...base, displayName: "" }, base),
    false,
    "changed but invalid",
  );
  assert.equal(
    canSubmitProfileDraft(
      { ...base, displayName: "" },
      { ...base, displayName: "" },
    ),
    false,
    "invalid and unchanged",
  );
  assert.equal(
    canSubmitProfileDraft({ ...base, displayName: "Sammy" }, base),
    true,
    "changed and valid",
  );
});
