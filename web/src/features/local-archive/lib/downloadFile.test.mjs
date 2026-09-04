import assert from "node:assert/strict";
import { test } from "node:test";
import { downloadBlob } from "./downloadFile.ts";

/** A DOM stub small enough to assert against, big enough to be real. */
function harness() {
  const created = [];
  const revoked = [];
  const appended = [];
  const timers = [];
  const anchors = [];
  let clicks = 0;
  const body = {
    appendChild: (node) => appended.push(node),
  };
  const deps = {
    createObjectURL: (blob) => {
      created.push(blob);
      return `blob:fake/${created.length}`;
    },
    revokeObjectURL: (url) => revoked.push(url),
    document: {
      body,
      createElement: () => {
        const anchor = {
          style: {},
          click: () => {
            clicks += 1;
          },
          remove: () => {
            appended.splice(appended.indexOf(anchor), 1);
          },
        };
        anchors.push(anchor);
        return anchor;
      },
    },
    setTimeout: (handler, delay) => timers.push({ handler, delay }),
  };
  return {
    deps,
    created,
    revoked,
    appended,
    anchors,
    timers,
    clicks: () => clicks,
  };
}

test("the anchor carries the filename and the object URL, and is clicked once", () => {
  const h = harness();
  const blob = { size: 3, type: "application/json" };
  const url = downloadBlob("buzz-general-2026-03-04.json", blob, h.deps);
  assert.equal(url, "blob:fake/1");
  assert.deepEqual(h.created, [blob], "the caller's blob is the one wrapped");
  assert.equal(h.clicks(), 1);
  assert.equal(h.anchors.length, 1);
  assert.equal(h.anchors[0].href, "blob:fake/1");
  assert.equal(
    h.anchors[0].download,
    "buzz-general-2026-03-04.json",
    "without the download attribute the browser navigates instead of saving",
  );
});

test("the anchor is removed from the document again", () => {
  const h = harness();
  downloadBlob("f.json", { size: 1 }, h.deps);
  assert.deepEqual(h.appended, [], "no orphan anchor is left in the body");
});

test("the object URL is revoked on a timer, not immediately", () => {
  const h = harness();
  const url = downloadBlob("f.json", { size: 1 }, h.deps);
  assert.deepEqual(
    h.revoked,
    [],
    "revoking before the browser reads it kills the download",
  );
  assert.equal(h.timers.length, 1);
  assert.ok(h.timers[0].delay > 0);
  h.timers[0].handler();
  assert.deepEqual(h.revoked, [url]);
});
