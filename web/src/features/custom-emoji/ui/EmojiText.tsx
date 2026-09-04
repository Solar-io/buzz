import { Fragment, useMemo } from "react";
import { emojiUrlMap, type CustomEmoji } from "../lib/customEmoji.ts";
import { splitShortcodes } from "../lib/shortcodeParts.ts";
import { CustomEmojiImage } from "./CustomEmojiImage";

/**
 * Plain text with any known `:shortcode:` replaced by its image.
 *
 * For the short, non-markdown strings — a reaction chip's label, a picker
 * preview. Message bodies go through markdown instead and get the remark
 * plugin (../lib/remarkCustomEmoji.ts), which has to walk an mdast tree and
 * skip code spans; doing that here would be the wrong tool.
 */
export function EmojiText({
  text,
  palette,
}: {
  text: string;
  palette: ReadonlyArray<CustomEmoji>;
}) {
  const parts = useMemo(
    () => splitShortcodes(text, emojiUrlMap(palette)),
    [text, palette],
  );

  return (
    <>
      {parts.map((part, index) =>
        part.kind === "emoji" ? (
          <CustomEmojiImage
            // Parts are positional and regenerate together; the index is the
            // only stable identity a text run has.
            // biome-ignore lint/suspicious/noArrayIndexKey: see comment above
            key={index}
            shortcode={part.shortcode}
            url={part.url}
          />
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: see comment above
          <Fragment key={index}>{part.value}</Fragment>
        ),
      )}
    </>
  );
}
