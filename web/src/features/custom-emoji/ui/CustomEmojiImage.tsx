import { cn } from "@/shared/lib/cn";

/**
 * One custom emoji rendered as an inline image.
 *
 * Sized in `em` so it tracks whatever text it sits in — message body, reaction
 * chip, picker cell — and follows Cmd +/- zoom for free, since the surrounding
 * font-size is rem-based.
 *
 * The `alt` is the literal `:shortcode:`. That is the NIP-30 fallback: a
 * reader whose image fails to load, or who copies the text out, gets the same
 * thing every other client would show them.
 */
export function CustomEmojiImage({
  shortcode,
  url,
  className,
}: {
  shortcode: string;
  url: string;
  className?: string;
}) {
  return (
    <img
      src={url}
      alt={`:${shortcode}:`}
      title={`:${shortcode}:`}
      loading="lazy"
      decoding="async"
      draggable={false}
      data-custom-emoji={shortcode}
      className={cn(
        "inline-block h-[1.375em] w-[1.375em] object-contain align-[-0.3em]",
        className,
      )}
    />
  );
}
