import assert from "node:assert/strict";
import { test } from "node:test";
import {
  publishShellSidebarWidth,
  SHELL_SIDEBAR_WIDTH_VAR,
  shellSidebarWidth,
} from "./shellCanvas.ts";

function fakeStyle() {
  const props = new Map();
  return {
    props,
    setProperty: (k, v) => props.set(k, v),
    removeProperty: (k) => props.delete(k),
  };
}

test("canvas split var name is the one globals.css reads", () => {
  assert.equal(SHELL_SIDEBAR_WIDTH_VAR, "--buzz-shell-sidebar-w");
});

test("split is the sidebar width at md+ with chrome", () => {
  assert.equal(
    shellSidebarWidth({ chromeless: false, phone: false, width: "232px" }),
    "232px",
  );
});

test("split is 0 when chromeless or on a phone (sidebar hidden)", () => {
  assert.equal(
    shellSidebarWidth({ chromeless: true, phone: false, width: "232px" }),
    "0px",
  );
  assert.equal(
    shellSidebarWidth({ chromeless: false, phone: true, width: "232px" }),
    "0px",
  );
});

test("publish sets the var and cleanup removes it", () => {
  const style = fakeStyle();
  const cleanup = publishShellSidebarWidth(style, "300px");
  assert.equal(style.props.get("--buzz-shell-sidebar-w"), "300px");
  cleanup();
  assert.equal(style.props.has("--buzz-shell-sidebar-w"), false);
});
