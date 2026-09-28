import assert from "node:assert/strict";
import { test } from "node:test";
import { favoriteMenuItem } from "./favoriteMenuItem.ts";
import { shortcutMenuItems } from "./shortcutMenuItems.ts";

test("the Favorites menu entry reads by state and runs its toggle", () => {
  let calls = 0;
  const add = favoriteMenuItem(false, () => {
    calls += 1;
  });
  assert.equal(add.label, "Add to Favorites");
  assert.equal(add.danger, undefined, "not a destructive entry");
  add.onSelect();
  assert.equal(calls, 1);
  assert.equal(favoriteMenuItem(true, () => {}).label, "Remove from Favorites");
});

test("a link menu leads with the Favorites entry only when wired", () => {
  const base = { onEdit: () => {}, onRemove: () => {} };
  assert.deepEqual(
    shortcutMenuItems(base).map((item) => item.label),
    ["Edit…", "Remove"],
  );
  assert.deepEqual(
    shortcutMenuItems({
      ...base,
      favorite: favoriteMenuItem(false, () => {}),
    }).map((item) => item.label),
    ["Add to Favorites", "Edit…", "Remove"],
  );
});
