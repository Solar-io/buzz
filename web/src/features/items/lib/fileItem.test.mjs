import assert from "node:assert/strict";
import test from "node:test";

import { fileItem } from "./fileItem.ts";
import { parseItemEvent } from "./itemEvent.ts";

const ME = "a".repeat(64);
const FLIGHT = "10000000-0000-4000-8000-000000000004";
const D = "7f3k2m9qa1bc";
const NOW = 1_759_190_400;

/** A fake socket: records the order of sign/publish and refuses on demand. */
function harness({ refuse = () => null } = {}) {
  const log = [];
  let seq = 0;
  const deps = {
    newId: () => D,
    nowS: NOW,
    sign: async (template) => {
      seq += 1;
      const event = {
        id: String(seq).repeat(64).slice(0, 64),
        pubkey: ME,
        created_at: template.created_at ?? NOW,
        kind: template.kind,
        tags: template.tags,
        content: template.content,
      };
      log.push(["sign", event.kind]);
      return event;
    },
    publish: async (event) => {
      log.push(["publish", event.kind]);
      const refusal = refuse(event);
      return refusal === null
        ? { ok: true, message: "" }
        : { ok: false, message: refusal };
    },
  };
  return { deps, log };
}

const input = {
  type: "bug",
  title: "Composer drops the draft",
  channelId: FLIGHT,
  reporter: ME,
  project: { name: "Buzz web", coordinate: null },
};

test("the row is signed first and the item published first; the item names the row", async () => {
  const { deps, log } = harness();
  const outcome = await fileItem(deps, input);
  assert.equal(outcome.ok, true);
  assert.deepEqual(log, [
    ["sign", 9],
    ["sign", 30623],
    ["publish", 30623],
    ["publish", 9],
  ]);
  const head = parseItemEvent(outcome.head);
  assert.equal(head.sourceEventId, outcome.row.id);
  assert.equal(head.channelId, FLIGHT);
  assert.equal(head.reporter, ME);
  assert.equal(head.status, "open");
  assert.equal(head.projectName, "Buzz web");
  assert.equal(head.created, NOW);
  assert.deepEqual(
    outcome.row.tags.find((tag) => tag[0] === "item"),
    ["item", D, "bug"],
  );
  assert.equal(outcome.rowRefused, null);
});

test("a refused item leaves no row behind, in the relay's words", async () => {
  const { deps, log } = harness({
    refuse: (event) =>
      event.kind === 30623 ? "restricted: not a channel member" : null,
  });
  const outcome = await fileItem(deps, input);
  assert.deepEqual(outcome, {
    ok: false,
    error: "restricted: not a channel member",
  });
  assert.equal(
    log.some(([step, kind]) => step === "publish" && kind === 9),
    false,
  );
});

test("a refused row after an accepted item is reported, not hidden", async () => {
  const { deps } = harness({
    refuse: (event) => (event.kind === 9 ? "rate-limited: slow down" : null),
  });
  const outcome = await fileItem(deps, input);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.rowRefused, "rate-limited: slow down");
});

test("a title the relay would refuse is refused before anything is published", async () => {
  const { deps, log } = harness();
  const outcome = await fileItem(deps, { ...input, title: "x".repeat(201) });
  assert.deepEqual(outcome, {
    ok: false,
    error: "item: title must be 1..=200 characters (got 201)",
  });
  assert.equal(log.filter(([step]) => step === "publish").length, 0);
});
