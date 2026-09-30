import assert from "node:assert/strict";
import { test } from "node:test";

import tailwindConfig from "../../../tailwind.config.js";
import { CUSTOM_FONT_SIZES, cn } from "./cn.ts";

test("a custom font size survives a colour in the same cn()", () => {
  // The regression: tailwind-merge read these as colours and dropped them.
  assert.equal(
    cn("text-sidebar-meta", "text-foreground"),
    "text-sidebar-meta text-foreground",
  );
  assert.equal(cn("text-badge text-honey-ink"), "text-badge text-honey-ink");
  assert.equal(
    cn("text-message", "text-muted-foreground"),
    "text-message text-muted-foreground",
  );
});

test("two sizes conflict and the later wins, custom or stock", () => {
  assert.equal(cn("text-sm", "text-sidebar-meta"), "text-sidebar-meta");
  assert.equal(cn("text-sidebar-meta", "text-xs"), "text-xs");
  assert.equal(cn("text-2xs", "text-badge"), "text-badge");
});

test("the list is exactly the config's fontSize keys", () => {
  const keys = Object.keys(tailwindConfig.theme.extend.fontSize);
  assert.ok(keys.length > 0, "the config must be read, not an empty object");
  assert.deepEqual([...CUSTOM_FONT_SIZES].sort(), [...keys].sort());
});
