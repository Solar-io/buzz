import { useMessageMedia } from "@/features/channels/ui/messageMediaContext.ts";
import { useFileTabs } from "./FileTabsProvider";
import { type FileKind, fileKind } from "./lib/fileKind.ts";
import { openFileFromSource } from "./lib/fileSource.ts";
import { fileTabKey } from "./lib/fileTabs.ts";

/**
 * What a file card or tile in a message does when clicked (web redesign
 * Phase 6): open the file in a tab beside the chat — with the message it
 * came in, so the tab can show its comments — or, outside the shell (no
 * FileTabsProvider: an issue body, a component test), download it as before.
 */
export function useTileOpener(file: {
  href: string;
  filename: string;
  size?: number;
}): {
  /** Null outside the shell: the caller downloads instead. */
  open: (() => void) | null;
  /** This file is the tab on screen. */
  selected: boolean;
  /** The message is a `buzz share` (its tile says "on the Shelf"). */
  onShelf: boolean;
  kind: FileKind;
  openShelf: (() => void) | null;
} {
  const tabs = useFileTabs();
  const { fileSource, imetaByUrl } = useMessageMedia();
  const mime = imetaByUrl?.get(file.href)?.m ?? null;
  const kind = fileKind(file.filename, mime);
  if (!tabs) {
    return {
      open: null,
      selected: false,
      onShelf: false,
      kind,
      openShelf: null,
    };
  }
  const key = fileTabKey(fileSource?.messageId ?? null, file.href);
  return {
    open: () =>
      tabs.open(
        openFileFromSource(fileSource ?? null, {
          href: file.href,
          filename: file.filename,
          size: file.size,
          mime,
        }),
      ),
    selected: tabs.state.active === key,
    onShelf: fileSource?.shelf === true,
    kind,
    openShelf: tabs.openShelf,
  };
}
