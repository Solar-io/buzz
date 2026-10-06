import assert from "node:assert/strict";
import test from "node:test";

import {
  locate,
  readFile,
  saveFile,
  sha256Hex,
  stashUrl,
} from "./stashClient.ts";

const FILES = "https://crichton.tailb3d4b8.ts.net:6831/";
const ADDR = { root: "home", rel: "docs/report.md" };
const D1 = "a".repeat(64);
const D2 = "b".repeat(64);

function fakeFetch(status, body, calls = []) {
  return async (url, init) => {
    calls.push({ url, init });
    if (status === "throw") {
      throw new TypeError("Failed to fetch");
    }
    return new Response(
      body === undefined || status === 304 ? null : JSON.stringify(body),
      { status, headers: { "Content-Type": "application/json" } },
    );
  };
}

test("urls hang off the Files URL with or without a trailing slash", () => {
  assert.equal(
    stashUrl("https://h:6831", "api/browser/locate", { abs: "/a b" }),
    "https://h:6831/api/browser/locate?abs=%2Fa+b",
  );
  assert.equal(
    stashUrl("https://h:6831/", "api/browser/file"),
    "https://h:6831/api/browser/file",
  );
});

test("locate maps the server's answers", async () => {
  const calls = [];
  assert.deepEqual(
    await locate(
      FILES,
      "/Users/sam/docs/report.md",
      fakeFetch(
        200,
        { ok: true, root: "home", rel: "docs/report.md", dir: false },
        calls,
      ),
    ),
    { kind: "ok", address: { root: "home", rel: "docs/report.md" } },
  );
  assert.equal(
    calls[0].url,
    "https://crichton.tailb3d4b8.ts.net:6831/api/browser/locate?abs=%2FUsers%2Fsam%2Fdocs%2Freport.md",
  );
  assert.equal(calls[0].init.credentials, "include");
  assert.deepEqual(
    await locate(
      FILES,
      "/x",
      fakeFetch(200, { ok: true, root: "home", rel: "x", dir: true }),
    ),
    { kind: "not-editable" },
  );
  assert.deepEqual(
    await locate(
      FILES,
      "/etc/x",
      fakeFetch(403, { error: "refused", reason: "outside_roots" }),
    ),
    { kind: "forbidden", reason: "outside_roots" },
  );
  assert.deepEqual(await locate(FILES, "/x", fakeFetch(401, {})), {
    kind: "signed-out",
  });
  assert.deepEqual(await locate(FILES, "/x", fakeFetch("throw")), {
    kind: "unreachable",
  });
});

test("read: 200 is the doc, 304 is not-modified, refusals are typed", async () => {
  const calls = [];
  const doc = {
    ok: true,
    content: "# Hi\n",
    size: 5,
    mtimeMs: 12.5,
    digest: D1,
    lossy: false,
  };
  assert.deepEqual(
    await readFile(FILES, ADDR, null, fakeFetch(200, doc, calls)),
    {
      kind: "ok",
      doc: {
        content: "# Hi\n",
        digest: D1,
        mtimeMs: 12.5,
        size: 5,
        lossy: false,
      },
    },
  );
  assert.equal(
    calls[0].url,
    "https://crichton.tailb3d4b8.ts.net:6831/api/browser/file?root=home&path=docs%2Freport.md",
  );
  await readFile(FILES, ADDR, 12.5, fakeFetch(304, undefined, calls));
  assert.equal(
    calls[1].url,
    "https://crichton.tailb3d4b8.ts.net:6831/api/browser/file?root=home&path=docs%2Freport.md&mtimeMs=12.5",
  );
  assert.deepEqual(await readFile(FILES, ADDR, 12.5, fakeFetch(304)), {
    kind: "not-modified",
  });
  assert.deepEqual(await readFile(FILES, ADDR, null, fakeFetch(413, {})), {
    kind: "too-large",
  });
  assert.deepEqual(await readFile(FILES, ADDR, null, fakeFetch(415, {})), {
    kind: "not-editable",
  });
  assert.deepEqual(await readFile(FILES, ADDR, null, fakeFetch(404, {})), {
    kind: "gone",
  });
  assert.deepEqual(
    await readFile(FILES, ADDR, null, fakeFetch(200, { content: "x" })),
    {
      kind: "unreachable",
    },
  );
});

test("409 maps to conflict with server digest", async () => {
  const result = await saveFile(
    FILES,
    ADDR,
    "draft",
    D1,
    fakeFetch(409, {
      error: "conflict",
      detail: "file changed on disk",
      size: 9,
      mtimeMs: 40,
      digest: D2,
    }),
  );
  assert.deepEqual(result, {
    kind: "conflict",
    digest: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    mtimeMs: 40,
    size: 9,
  });
  assert.deepEqual(
    await saveFile(
      FILES,
      ADDR,
      "d",
      D1,
      fakeFetch(409, { error: "conflict", digest: null, mtimeMs: null }),
    ),
    { kind: "gone" },
  );
});

test("PUT sends JSON content-type and credentials", async () => {
  const calls = [];
  const result = await saveFile(
    FILES,
    ADDR,
    "new text\n",
    D1,
    fakeFetch(200, { ok: true, size: 9, mtimeMs: 50, digest: D2 }, calls),
  );
  assert.deepEqual(result, { kind: "ok", digest: D2, mtimeMs: 50, size: 9 });
  const { url, init } = calls[0];
  assert.equal(url, "https://crichton.tailb3d4b8.ts.net:6831/api/browser/file");
  assert.equal(init.method, "PUT");
  assert.equal(init.credentials, "include");
  assert.equal(init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(init.body), {
    root: "home",
    path: "docs/report.md",
    content: "new text\n",
    digest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });
});

test("save refusals keep their meaning", async () => {
  assert.deepEqual(
    await saveFile(
      FILES,
      ADDR,
      "d",
      D1,
      fakeFetch(403, { error: "refused", reason: "write_denied" }),
    ),
    { kind: "forbidden", reason: "write_denied" },
  );
  assert.deepEqual(await saveFile(FILES, ADDR, "d", D1, fakeFetch(413, {})), {
    kind: "too-large",
  });
  assert.deepEqual(await saveFile(FILES, ADDR, "d", D1, fakeFetch("throw")), {
    kind: "unreachable",
  });
});

test("sha256Hex is stash's digest of the UTF-8 bytes", async () => {
  assert.equal(
    await sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});
