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
  loadFileWidth,
  type OpenFile,
  openFileTab,
  saveFileWidth,
  selectFileTab,
  setFileTabsExpanded,
} from "./lib/fileTabs.ts";
import { useDockedPane } from "./useDockedPane.ts";

const FilePreviewSheet = lazy(() =>
  import("./ui/FilePreviewSheet").then((module) => ({
    default: module.FilePreviewSheet,
  })),
);

/**
 * Open files for the whole shell (web redesign Phase 6): a tile in a
 * message, a Shelf row and a ⌘-click anywhere else all open into the same
 * tabs, which the right pane draws beside Work at lg. Below lg there is no
 * dock, so the active file is a full-screen sheet instead — and closing the
 * sheet closes the file, since a phone has no strip to come back to it from.
 *
 * Navigation arrives from the shell as callbacks: the provider sits inside
 * the router, but tiles also render where no route is (component tests).
 */
export interface FileTabsContextValue {
  state: FileTabsState;
  open: (file: OpenFile) => void;
  close: (key: string) => void;
  /** A file tab, or null for the shell's own tab. */
  select: (key: string | null) => void;
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
    (key: string) => setState((previous) => closeFileTab(previous, key)),
    [],
  );
  const select = useCallback(
    (key: string | null) =>
      setState((previous) => selectFileTab(previous, key)),
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
      setExpanded,
      width,
      setWidth,
      onOpenMessage,
      onOpenShelf,
    ],
  );
  const active =
    state.active === null
      ? null
      : (state.files.find((file) => file.key === state.active) ?? null);

  return (
    <FileTabsContext.Provider value={value}>
      {children}
      {!docked && active !== null ? (
        <Suspense fallback={null}>
          <FilePreviewSheet file={active} onClose={() => close(active.key)} />
        </Suspense>
      ) : null}
    </FileTabsContext.Provider>
  );
}
