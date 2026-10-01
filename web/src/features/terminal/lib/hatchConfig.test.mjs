import assert from "node:assert/strict";
import { test } from "node:test";

import {
  hatchOrigin,
  hatchWsUrl,
  normalizeHatchUrl,
  resolveHatchUrl,
} from "./hatchConfig.ts";

/** W-4: unset in both places → null → no Terminal row, no crichton rows. */

test("unset (or blank) in both places resolves to null", () => {
  assert.equal(resolveHatchUrl({ env: "", stored: null }), null);
  assert.equal(resolveHatchUrl({ env: undefined, stored: undefined }), null);
  assert.equal(resolveHatchUrl({ env: "  ", stored: "" }), null);
});

test("the build value is used; a per-browser override wins over it", () => {
  assert.equal(
    resolveHatchUrl({
      env: "https://crichton.tailb3d4b8.ts.net:6881/",
      stored: null,
    }),
    "https://crichton.tailb3d4b8.ts.net:6881/",
  );
  assert.equal(
    resolveHatchUrl({
      env: "https://crichton.tailb3d4b8.ts.net:6881/",
      stored: "https://crichton.tailb3d4b8.ts.net:6871",
    }),
    "https://crichton.tailb3d4b8.ts.net:6871/",
  );
});

test("only http(s) origins count as a service address", () => {
  assert.equal(normalizeHatchUrl("javascript:alert(1)"), null);
  assert.equal(normalizeHatchUrl("/relative"), null);
  assert.equal(
    normalizeHatchUrl("https://h.test:6881/some/path?x=1"),
    "https://h.test:6881/",
  );
});

test("the socket URL is wss for https, ws for http, at /ws/term", () => {
  const q = new URLSearchParams({ id: "t-1", cols: "80", rows: "24" });
  assert.equal(
    hatchWsUrl("https://h.test:6881/", q),
    "wss://h.test:6881/ws/term?id=t-1&cols=80&rows=24",
  );
  assert.equal(
    hatchWsUrl("http://127.0.0.1:6870/", q),
    "ws://127.0.0.1:6870/ws/term?id=t-1&cols=80&rows=24",
  );
  assert.equal(hatchOrigin("https://h.test:6881/"), "https://h.test:6881");
});
