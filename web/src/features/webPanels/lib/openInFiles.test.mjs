import assert from "node:assert/strict";
import { test } from "node:test";

import { filesPathUrl, isFilesPath } from "./openInFiles.ts";

const STASH = "https://crichton.tailb3d4b8.ts.net:6831/";

test("an absolute path becomes stash's ?path= deep link", () => {
  assert.equal(
    filesPathUrl(STASH, "/Users/sam/MEGA/shared_files/dropbox/rts-bakeoff"),
    "https://crichton.tailb3d4b8.ts.net:6831/?path=%2FUsers%2Fsam%2FMEGA%2Fshared_files%2Fdropbox%2Frts-bakeoff",
  );
});

test("a path with spaces, # and & round-trips through the query", () => {
  const path = "/Users/sam/My Files/a&b #1.md";
  const url = new URL(filesPathUrl(STASH, path));
  assert.equal(url.searchParams.get("path"), path);
  assert.equal(url.hash, "", "# stays inside the value");
});

test("keeps the panel's own query, drops root= and any fragment", () => {
  const url = new URL(
    filesPathUrl(`${STASH}?theme=light&root=home#buzz-theme=abc`, "/tmp/x"),
  );
  assert.equal(url.searchParams.get("theme"), "light");
  assert.equal(url.searchParams.get("root"), null);
  assert.equal(url.searchParams.get("path"), "/tmp/x");
  assert.equal(url.hash, "");
});

test("relative, home-relative, NUL and oversized paths are refused", () => {
  for (const bad of [
    "",
    "Users/sam",
    "~/MEGA",
    "./x",
    "/x\0y",
    `/${"a".repeat(4096)}`,
  ]) {
    assert.equal(isFilesPath(bad), false, JSON.stringify(bad.slice(0, 12)));
    assert.equal(filesPathUrl(STASH, bad), null);
  }
  assert.equal(isFilesPath(`/${"a".repeat(4095)}`), true, "4096 exactly");
});

test("a panel URL that does not parse gives null, not a guess", () => {
  assert.equal(filesPathUrl("not a url", "/tmp"), null);
});
