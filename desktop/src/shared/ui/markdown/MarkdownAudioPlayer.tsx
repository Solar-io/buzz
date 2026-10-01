import type * as React from "react";

/**
 * Inline player for an MP3 attachment, rendered under its download card.
 *
 * `resolvedSrc` is already rewritten through the local media proxy
 * (`rewriteRelayUrl`, done by `resolveFileCard`), the same path the inline
 * video player streams from, so `<audio>` can load it directly.
 */
export function MarkdownAudioPlayer({
  children,
  filename,
  resolvedSrc,
}: {
  children: React.ReactNode;
  filename: string;
  resolvedSrc: string;
}) {
  return (
    <span
      className="my-1 flex max-w-sm flex-col gap-1"
      data-block-media=""
      data-testid="markdown-audio"
    >
      {children}
      {/* biome-ignore lint/a11y/useMediaCaption: no caption track exists for user uploads */}
      <audio
        aria-label={`Audio attachment: ${filename}`}
        className="h-8 w-full"
        controls
        preload="metadata"
        src={resolvedSrc}
      />
    </span>
  );
}
