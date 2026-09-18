import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveDocHref } from "./docLinks.ts";

const RELAY = "https://crichton.tailb3d4b8.ts.net:6351";

test("resolveDocHref rewrites upstream docs links to same-origin paths", () => {
  assert.equal(
    resolveDocHref(
      "http://crichton.tailb3d4b8.ts.net:6451/changelog.md",
      RELAY,
    ),
    "/changelog.md",
  );
  assert.equal(
    resolveDocHref(
      "https://crichton.tailb3d4b8.ts.net:6451/tracker.json",
      RELAY,
    ),
    "/tracker.json",
  );
  // The Daily Edition upstream on :6450 mirrors too.
  assert.equal(
    resolveDocHref(
      "http://crichton.tailb3d4b8.ts.net:6450/edition/latest.html",
      RELAY,
    ),
    "/edition/latest.html",
  );
});

test("resolveDocHref keeps the relay-canonicalized spellings as-is", () => {
  // The relay maps /changelog → /changelog.md and trims /tracker/ itself;
  // the rewrite is a pure origin swap, so the path passes through.
  assert.equal(
    resolveDocHref("http://crichton.tailb3d4b8.ts.net:6451/changelog", RELAY),
    "/changelog",
  );
  assert.equal(
    resolveDocHref("http://crichton.tailb3d4b8.ts.net:6451/tracker/", RELAY),
    "/tracker/",
  );
});

test("resolveDocHref rejects evil hosts", () => {
  assert.equal(
    resolveDocHref("http://evil.example:6451/changelog.md", RELAY),
    null,
    "a same-port link on a foreign host must not rewrite",
  );
});

test("resolveDocHref rejects ports outside the served pair", () => {
  // :6452 is the notifications page — deliberately out of scope.
  assert.equal(
    resolveDocHref(
      "http://crichton.tailb3d4b8.ts.net:6452/changelog.md",
      RELAY,
    ),
    null,
  );
  // The relay's own port is not an upstream port.
  assert.equal(
    resolveDocHref(
      "https://crichton.tailb3d4b8.ts.net:6351/changelog.md",
      RELAY,
    ),
    null,
  );
  // Default-port (no explicit port) https links are not upstream links.
  assert.equal(
    resolveDocHref("https://crichton.tailb3d4b8.ts.net/changelog.md", RELAY),
    null,
  );
});

test("resolveDocHref rejects paths outside the served set", () => {
  assert.equal(
    resolveDocHref("http://crichton.tailb3d4b8.ts.net:6451/repos", RELAY),
    null,
  );
  assert.equal(
    resolveDocHref(
      "http://crichton.tailb3d4b8.ts.net:6451/changelog.md/../x",
      RELAY,
    ),
    null,
  );
});

test("resolveDocHref handles relative and unparsable hrefs", () => {
  // Relative hrefs have no upstream port — null, not a crash.
  assert.equal(resolveDocHref("/changelog.md", RELAY), null);
  assert.equal(resolveDocHref("not a url", RELAY), null);
});
