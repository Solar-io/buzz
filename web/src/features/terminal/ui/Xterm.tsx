import { useEffect, useRef } from "react";

import {
  mountTerminal,
  type MountOptions,
  type TerminalHandle,
} from "../emulator/boot.ts";

/**
 * The thin React mount (phase-7.md §8 `ui/Xterm.tsx`): one `mountTerminal`
 * per mount, disposed on unmount. No React state per byte — the emulator
 * owns the DOM below this element. Options are read through a ref so a
 * re-render never rebuilds the terminal (which would drop the socket).
 */
export function Xterm({
  options,
  onHandle,
  className,
}: {
  options: MountOptions;
  onHandle: (handle: TerminalHandle | null) => void;
  className?: string;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const latest = useRef(options);
  latest.current = options;
  const handleRef = useRef(onHandle);
  handleRef.current = onHandle;

  useEffect(() => {
    const element = host.current;
    if (!element) {
      return;
    }
    const handle = mountTerminal(element, {
      socketUrl: (query) => latest.current.socketUrl(query),
      onState: (state) => latest.current.onState(state),
      diagnose: () => latest.current.diagnose(),
      upload: (file, name) =>
        latest.current.upload
          ? latest.current.upload(file, name)
          : Promise.reject(new Error("uploads unavailable")),
      onNotice: (text, tone) => latest.current.onNotice?.(text, tone),
      onCtrlChange: (armed) => latest.current.onCtrlChange?.(armed),
      onRenderer: (kind) => latest.current.onRenderer?.(kind),
      fontSize: latest.current.fontSize,
    });
    handleRef.current(handle);
    return () => {
      handleRef.current(null);
      handle.dispose();
    };
  }, []);

  return (
    <div
      ref={host}
      data-testid="terminal-mount"
      className={className}
      // xterm's own CSS sizes .xterm to its parent; the mount only clips.
    />
  );
}
