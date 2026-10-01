import { htmlPreviewFrame } from "../lib/htmlPreview.ts";

/**
 * A shared HTML file, running — in an opaque-origin sandbox (see
 * `lib/htmlPreview.ts` for why each permission is absent). The bytes arrive
 * as `srcdoc`; the frame never loads the media URL.
 *
 * `key` on the caller remounts it for "Reload preview".
 */
export function HtmlPreview({
  html,
  title,
  className,
}: {
  html: string;
  title: string;
  className?: string;
}) {
  const frame = htmlPreviewFrame(html);
  return (
    <iframe
      data-testid="html-preview-frame"
      title={`Preview of ${title}`}
      sandbox={frame.sandbox}
      srcDoc={frame.srcDoc}
      referrerPolicy={frame.referrerPolicy}
      allow={frame.allow}
      className={className}
    />
  );
}
