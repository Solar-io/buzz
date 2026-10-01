import {
  createContext,
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import {
  closeFileTab,
  EMPTY_FILE_TABS,
  type FileTabsState,
  fileOnScreen,
  loadFileWidth,
  type OpenFile,
  openFileTab,
  saveFileWidth,
  selectFileTab,
  setFileTabsExpanded,
  showCanvas,
} from "./lib/fileTabs.ts";
import { useDockedPane } from "./useDockedPane.ts";

const FilePreviewSheet = lazy(() =>
  import("./ui/FilePreviewSheet").then((module) => ({
    default: module.FilePreviewSheet,
  })),
);

/**
 * The right pane's Canvas for the whole shell: a tile in a message, a Shelf
 * row and a ⌘-click anywhere else all open into the same Canvas, which the
 * right pane draws as its second tab at lg (Work | Canvas). Below lg there
 * is no dock, so the file on screen is a full-screen sheet instead — and
 * closing the sheet closes the file, since a phone has no strip to come
 * back to it from.
 *
 * Navigation arrives from the shell as callbacks: the provider sits inside
 * the router, but tiles also render where no route is (component tests).
 */
export interface FileTabsContextValue {
  state: FileTabsState;
  open: (file: OpenFile) => void;
  /** Close a file; `items` is the Canvas order as drawn (see closeFileTab). */
  close: (key: string, items?: readonly string[]) => void;
  /** Pick a Canvas document (a file key or CHANNEL_CANVAS_KEY). */
  select: (key: string) => void;
  /** Show Canvas, or hand the pane back to Work / Thinking. */
  show: (open: boolean) => void;
  setExpanded: (expanded: boolean) => void;
  /** The file pane's docked width (persisted). */
  width: number;
  setWidth: (update: (previous: number) => number) => void;
  /** Go to the message a file was shared in. */
  openMessage: (channelId: string, messageId: string) => void;
  /** Open the Shelf page. */
  openShelf: () => void;
}

const FileTabsContext = createContext<FileTabsContextValue | null>(null);

/** Null outside the provider: tiles then fall back to downloading. */
export function useFileTabs(): FileTabsContextValue | null {
  return useContext(FileTabsContext);
}

export function FileTabsProvider({
  onOpenMessage,
  onOpenShelf,
  children,
}: {
  onOpenMessage: (channelId: string, messageId: string) => void;
  onOpenShelf: () => void;
  children: ReactNode;
}) {
  const [state, setState] = useState<FileTabsState>(EMPTY_FILE_TABS);
  const [width, setWidthState] = useState(() => loadFileWidth());
  const docked = useDockedPane();
  useEffect(() => saveFileWidth(width), [width]);

  const open = useCallback(
    (file: OpenFile) => setState((previous) => openFileTab(previous, file)),
    [],
  );
  const close = useCallback(
    (key: string, items?: readonly string[]) =>
      setState((previous) => closeFileTab(previous, key, items)),
    [],
  );
  const select = useCallback(
    (key: string) => setState((previous) => selectFileTab(previous, key)),
    [],
  );
  const show = useCallback(
    (next: boolean) => setState((previous) => showCanvas(previous, next)),
    [],
  );
  const setExpanded = useCallback(
    (expanded: boolean) =>
      setState((previous) => setFileTabsExpanded(previous, expanded)),
    [],
  );
  const setWidth = useCallback(
    (update: (previous: number) => number) => setWidthState(update),
    [],
  );

  const value = useMemo<FileTabsContextValue>(
    () => ({
      state,
      open,
      close,
      select,
      show,
      setExpanded,
      width,
      setWidth,
      openMessage: onOpenMessage,
      openShelf: onOpenShelf,
    }),
    [
      state,
      open,
      close,
      select,
      show,
      setExpanded,
      width,
      setWidth,
      onOpenMessage,
      onOpenShelf,
    ],
  );
  const sheetKey = fileOnScreen(state);
  const sheet =
    sheetKey === null
      ? null
      : (state.files.find((file) => file.key === sheetKey) ?? null);

  return (
    <FileTabsContext.Provider value={value}>
      {children}
      {!docked && sheet !== null ? (
        <Suspense fallback={null}>
          <FilePreviewSheet file={sheet} onClose={() => close(sheet.key)} />
        </Suspense>
      ) : null}
    </FileTabsContext.Provider>
  );
}
