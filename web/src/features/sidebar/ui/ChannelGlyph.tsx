import { Hash, Lock, MessageSquareText } from "lucide-react";

/** Props for {@link ChannelGlyph}. */
export interface ChannelGlyphProps {
  isPrivate?: boolean;
}

/** The desktop's channel glyphs: Hash for public, Lock for private. */
export function ChannelGlyph({ isPrivate }: ChannelGlyphProps) {
  const Glyph = isPrivate ? Lock : Hash;
  return (
    <Glyph
      aria-hidden="true"
      className="h-4 w-4 shrink-0 text-sidebar-foreground/60"
    />
  );
}

/** Forum channels get the desktop forum glyph instead of the Hash. */
export function ChannelForum() {
  return (
    <MessageSquareText
      aria-hidden="true"
      className="h-4 w-4 shrink-0 text-sidebar-foreground/60"
    />
  );
}
