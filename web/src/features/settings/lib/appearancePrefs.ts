/**
 * Appearance preferences — the pure half.
 *
 * Ported from the desktop client's four separate preference modules
 * (`shared/lib/fontSizePreference.ts`, `conversationDensityPreference.ts`,
 * `linkPreviewStylePreference.ts`, and
 * `features/channels/lib/threadViewModePreference.ts`). Each of those repeats
 * the same ~90 lines with one type swapped; here the shape is a data structure
 * and the behaviour is written once, in `appearanceStore.ts`.
 *
 * This file holds NO DOM and NO React on purpose. `node --test` cannot load a
 * module that reaches `document` at import time, and these are the parts worth
 * pinning: the storage keys (kept identical to the desktop client's so the
 * two implementations describe the same preference rather than drifting), the
 * root attribute names (the CSS in `shared/styles/globals.css` selects on
 * them), and the parse function that decides what a corrupted or absent value
 * falls back to.
 *
 * The 13 / 14 / 15px font-size contract is NOT here. It lives in
 * `globals.css` as `--buzz-type-scale`, exactly as this repo's CLAUDE.md
 * requires: the preference records a choice, the tokens carry the sizes, and
 * no component hardcodes a px value per preference.
 */

/** Device-level type scale. Smaller / Default / Larger = 13 / 14 / 15px. */
export type FontSize = "smaller" | "default" | "larger";

/** Device-level spacing across conversation surfaces. */
export type ConversationDensity = "compact" | "comfortable" | "spacious";

/** How sender-authored link preview cards are presented. */
export type LinkPreviewStyle = "compact" | "rich";

/** Whether a thread opens over the channel or beside it. */
export type ThreadLayout = "focus" | "split";

/**
 * One preference: where it is stored, which root attribute carries it, what a
 * fresh browser gets, and which values are legal.
 */
export interface PreferenceSpec<Value extends string> {
  /** localStorage key. Matches the desktop client's, deliberately. */
  readonly storageKey: string;
  /** Attribute set on `<html>`; the CSS in globals.css selects on it. */
  readonly attribute: string;
  readonly defaultValue: Value;
  readonly values: readonly Value[];
}

export const FONT_SIZE_PREFERENCE: PreferenceSpec<FontSize> = {
  storageKey: "buzz.appearance.fontSize",
  attribute: "data-font-size",
  defaultValue: "default",
  values: ["smaller", "default", "larger"],
};

export const CONVERSATION_DENSITY_PREFERENCE: PreferenceSpec<ConversationDensity> =
  {
    storageKey: "buzz.appearance.conversationDensity",
    attribute: "data-conversation-density",
    defaultValue: "comfortable",
    values: ["compact", "comfortable", "spacious"],
  };

export const LINK_PREVIEW_STYLE_PREFERENCE: PreferenceSpec<LinkPreviewStyle> = {
  storageKey: "buzz.appearance.linkPreviewStyle",
  attribute: "data-link-preview-style",
  defaultValue: "compact",
  values: ["compact", "rich"],
};

export const THREAD_LAYOUT_PREFERENCE: PreferenceSpec<ThreadLayout> = {
  storageKey: "buzz.channels.threadViewMode",
  attribute: "data-thread-layout",
  defaultValue: "split",
  values: ["focus", "split"],
};

/** Every preference this module owns, for bulk initialization. */
export const APPEARANCE_PREFERENCES = [
  FONT_SIZE_PREFERENCE,
  CONVERSATION_DENSITY_PREFERENCE,
  LINK_PREVIEW_STYLE_PREFERENCE,
  THREAD_LAYOUT_PREFERENCE,
] as const;

/**
 * Coerce a stored value to a legal one.
 *
 * Anything unrecognised — absent, corrupted, or written by a future version
 * that added a value this build does not know — falls back to the default
 * rather than being applied blindly, because the value ends up in a DOM
 * attribute that CSS matches on.
 */
export function parsePreference<Value extends string>(
  spec: PreferenceSpec<Value>,
  raw: string | null | undefined,
): Value {
  return spec.values.includes(raw as Value)
    ? (raw as Value)
    : spec.defaultValue;
}
