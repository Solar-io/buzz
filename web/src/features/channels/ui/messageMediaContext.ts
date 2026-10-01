import { createContext, useContext } from "react";

import type { FileSource } from "@/features/shelf/lib/fileSource.ts";
import type { ImetaEntry } from "../lib/imetaEntries.ts";

/**
 * Per-message media context. `MessageMedia` is registered as react-markdown's
 * `img` component, so it cannot receive per-message props directly — the
 * imeta map and the gallery opener arrive through this context instead, and
 * the component identity stays module-stable so the paragraph classifier can
 * recognise its own media children by reference.
 *
 * Its own module so the file cards and tiles can read it without importing
 * MessageMedia (which imports them).
 */
export interface MessageMediaContextValue {
  imetaByUrl?: Map<string, ImetaEntry>;
  /** Open the message-scoped lightbox gallery at the clicked trigger. */
  openGallery: (trigger: HTMLElement) => void;
  /**
   * The message the attachments belong to (web redesign Phase 6): a file
   * tile opens its file in a tab with this, so comments reply to it. Absent
   * where markdown renders outside a message (an issue body, a preview).
   */
  fileSource?: FileSource;
}

export const MessageMediaContext = createContext<MessageMediaContextValue>({
  openGallery: () => {},
});

export function useMessageMedia(): MessageMediaContextValue {
  return useContext(MessageMediaContext);
}
