import assert from "node:assert/strict";
import { test } from "node:test";

// Sam opens Files from a sidebar Link, which renders ShortcutOverlay rather
// than FilesPanel. Focus mode must reach the dock on this path too, or the
// maximize button never appears (2026-09-24: shipped without it).
globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  "../hooks.ts": `
    export function useShortcutDock() { return { id: "dock" }; }
  `,
  "@/features/webPanels/ui/WebPanelDock": `
    export function WebPanelDock() { return null; }
  `,
};

const { ShortcutOverlay } = await import("./ShortcutOverlay.tsx");

test("overlay passes focus mode through to the dock", () => {
  const onFocusModeChange = () => {};
  const onClose = () => {};
  const el = ShortcutOverlay({
    focusMode: true,
    initialPanelId: "files",
    onClose,
    onFocusModeChange,
  });
  assert.equal(el.type.name, "WebPanelDock");
  const props = el.props;
  assert.equal(props.focusMode, true);
  assert.equal(props.onFocusModeChange, onFocusModeChange);
  assert.equal(props.initialPanelId, "files");
  assert.equal(props.onClose, onClose);
});
