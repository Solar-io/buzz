import assert from "node:assert/strict";
import { test } from "node:test";
import { paletteActions } from "./paletteActions.ts";

const noop = () => {};

function actions() {
  return paletteActions({
    openView: noop,
    openSettings: noop,
    openAgents: noop,
    onNewChannel: noop,
    onNewDm: noop,
    onOpenFiles: noop,
  });
}

test("paletteActions pins the full action roster and order", () => {
  assert.deepEqual(
    actions().map((action) => action.id),
    [
      "action:new-channel",
      "action:new-dm",
      "action:inbox",
      "action:onboarding",
      "action:projects",
      "action:pulse",
      "action:reminders",
      "action:workflows",
      "action:files",
      "action:settings",
      "action:agents",
    ],
  );
});

test("paletteActions routes each view action to its view", () => {
  const opened = [];
  const list = paletteActions({
    openView: (view) => opened.push(view),
    openSettings: noop,
    openAgents: noop,
    onNewChannel: noop,
    onNewDm: noop,
    onOpenFiles: noop,
  });
  const views = {
    "action:inbox": "inbox",
    "action:onboarding": "onboarding",
    "action:projects": "projects",
    "action:pulse": "pulse",
    "action:reminders": "reminders",
    "action:workflows": "workflows",
  };
  for (const id of Object.keys(views)) {
    list.find((action) => action.id === id)?.onSelect?.();
  }
  assert.deepEqual(opened, Object.values(views));
});

test("paletteActions wires the dialog actions to their callbacks", () => {
  const calls = [];
  const list = paletteActions({
    openView: () => calls.push("view"),
    openSettings: () => calls.push("settings"),
    openAgents: () => calls.push("agents"),
    onNewChannel: () => calls.push("new-channel"),
    onNewDm: () => calls.push("new-dm"),
    onOpenFiles: () => calls.push("files"),
  });
  for (const id of [
    "action:new-channel",
    "action:new-dm",
    "action:files",
    "action:settings",
    "action:agents",
  ]) {
    list.find((action) => action.id === id)?.onSelect?.();
  }
  assert.deepEqual(calls, [
    "new-channel",
    "new-dm",
    "files",
    "settings",
    "agents",
  ]);
});
