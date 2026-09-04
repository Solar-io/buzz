import { cn } from "@/shared/lib/cn";

/**
 * A user-status emoji.
 *
 * A status emoji is a bare string (unlike a reaction, which carries a
 * companion image URL): normally a native glyph. The desktop additionally
 * resolves a `:shortcode:` against its custom-emoji pack; the web client has
 * no custom-emoji feature, so an unresolvable shortcode renders as the text
 * it is rather than as a broken image. Every status display site goes through
 * this component so that stays true in one place if the web ever gains one.
 */
export function StatusEmoji({
  value,
  className,
}: {
  value: string | undefined;
  className?: string;
}) {
  if (!value) {
    return null;
  }
  return (
    <span
      aria-hidden
      className={cn("inline-flex items-center justify-center", className)}
      title={value}
    >
      {value}
    </span>
  );
}
