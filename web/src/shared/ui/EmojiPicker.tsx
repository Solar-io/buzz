/**
 * Compatibility re-export.
 *
 * The picker is no longer a 48-glyph palette — it is search, categories, skin
 * tones, the community's NIP-30 custom emoji, and a relay-backed GIF tab. That
 * makes it a feature, not a shared primitive: it reads the relay session for
 * the emoji palette and the NIP-11 GIF capability, and `shared/` must not
 * depend on `features/`.
 *
 * So the component now lives in `features/custom-emoji/ui/EmojiPicker.tsx`,
 * and this file exists only so the two existing call sites
 * (`features/channels/ui/Composer.tsx`,
 * `features/channels/ui/MessageActionBar.tsx`) keep resolving. Point them at
 * the feature and delete this file — MessageActionBar is not owned by the
 * change that moved it, which is the whole reason the shim is here.
 */

export { EmojiPicker } from "@/features/custom-emoji/ui/EmojiPicker";
