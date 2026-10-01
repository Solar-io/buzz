import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FILES_URL_STORAGE_KEY,
  LEGACY_FILES_URL_STORAGE_KEY,
  resolveFilesUrl,
  writeFilesUrl,
} from "./filesConfig.ts";

const STASH = "https://crichton.tailb3d4b8.ts.net:6831/";
const RETIRED = "https://crichton.tailb3d4b8.ts.net:6201/?panel=files";

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

test("a legacy override no longer shadows the build default (the :6201 regression)", () => {
  const storage = memoryStorage({ [LEGACY_FILES_URL_STORAGE_KEY]: RETIRED });
  assert.equal(resolveFilesUrl(storage, STASH), STASH);
  assert.equal(storage.map.has(LEGACY_FILES_URL_STORAGE_KEY), false);
  assert.equal(storage.map.has(FILES_URL_STORAGE_KEY), false);
});

test("with no build default the legacy override still works, and migrates", () => {
  const storage = memoryStorage({
    [LEGACY_FILES_URL_STORAGE_KEY]: ` ${RETIRED} `,
  });
  assert.equal(resolveFilesUrl(storage, ""), RETIRED);
  assert.equal(storage.map.get(FILES_URL_STORAGE_KEY), RETIRED);
  assert.equal(storage.map.has(LEGACY_FILES_URL_STORAGE_KEY), false);
  // Second read comes from the v2 key.
  assert.equal(resolveFilesUrl(storage, ""), RETIRED);
});

test("an override saved now (v2) still wins over the build default", () => {
  const storage = memoryStorage();
  writeFilesUrl(storage, "https://files.example.test/");
  assert.equal(resolveFilesUrl(storage, STASH), "https://files.example.test/");
});

test("nothing stored resolves to the build default; no storage too", () => {
  assert.equal(resolveFilesUrl(memoryStorage(), STASH), STASH);
  assert.equal(resolveFilesUrl(null, STASH), STASH);
  assert.equal(resolveFilesUrl(memoryStorage(), ""), "");
});

test("writing clears the legacy key; clearing falls back to the build default", () => {
  const storage = memoryStorage({ [LEGACY_FILES_URL_STORAGE_KEY]: RETIRED });
  writeFilesUrl(storage, "https://files.example.test/");
  assert.equal(storage.map.has(LEGACY_FILES_URL_STORAGE_KEY), false);
  writeFilesUrl(storage, null);
  assert.equal(storage.map.size, 0);
  assert.equal(resolveFilesUrl(storage, STASH), STASH);
});
