import assert from "node:assert/strict";
import test from "node:test";

import { readAtForPreservedUnreadMessage } from "./unreadThreadEventIds.ts";

test("authoritative unread id stays unread behind a newer revisit frontier", () => {
  const messageId = "reply";
  assert.equal(
    readAtForPreservedUnreadMessage(messageId, new Set([messageId]), null, 500),
    null,
  );
});

test("non-preserved message still folds the channel frontier", () => {
  assert.equal(
    readAtForPreservedUnreadMessage("reply", new Set(), 100, 500),
    500,
  );
});
