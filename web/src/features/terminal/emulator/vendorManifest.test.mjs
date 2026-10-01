import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * W-5: every vendored file matches its MANIFEST.json sha256, nothing is
 * unlisted, and the xterm addons are the 5.5.0 publish batch (webgl 0.18.0,
 * canvas 0.7.0, fit 0.10.0, clipboard 0.1.0) — the 0.19.0 / 0.11.0 batch is
 * xterm 6 and reaches into internals 5.5 does not have.
 */

const VENDOR = new URL("../../../../public/assets/vendor/", import.meta.url);

for (const dir of ["xterm-5.5.0", "nerd-font-1"]) {
  test(`${dir}: every file matches its manifest hash, and nothing is unlisted`, () => {
    const base = new URL(`${dir}/`, VENDOR);
    const manifest = JSON.parse(
      readFileSync(new URL("MANIFEST.json", base), "utf8"),
    );
    const listed = Object.keys(manifest.files).sort();
    const onDisk = readdirSync(base)
      .filter((name) => name !== "MANIFEST.json")
      .sort();
    assert.ok(listed.length > 0);
    assert.deepEqual(onDisk, listed);
    for (const name of listed) {
      const hash = createHash("sha256")
        .update(readFileSync(new URL(name, base)))
        .digest("hex");
      assert.equal(hash, manifest.files[name].sha256, `${dir}/${name}`);
    }
  });
}

test("the xterm addons are the 5.5.0 batch, by version AND by hash", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("xterm-5.5.0/MANIFEST.json", VENDOR), "utf8"),
  );
  const versions = Object.fromEntries(
    Object.entries(manifest.files).map(([name, entry]) => [
      name,
      entry.version,
    ]),
  );
  assert.deepEqual(versions, {
    "xterm.js": "5.5.0",
    "addon-fit.js": "0.10.0",
    "addon-clipboard.js": "0.1.0",
    "addon-webgl.js": "0.18.0",
    "addon-canvas.js": "0.7.0",
    "xterm.css": "5.5.0",
    LICENSE: "5.5.0",
  });
  // Pinned here too, so editing the manifest alongside a swapped file fails.
  assert.equal(
    manifest.files["addon-webgl.js"].sha256,
    "7af02c9f6054c7d49179e53854c7a1b027eb3040c6ca6dc4acd532fc89ec33b7",
  );
  assert.equal(
    manifest.files["xterm.js"].sha256,
    "1f991ac3b4b283ebf96e60ae23a00a52765dd3a2e46fa6fdda9f1aab032f7495",
  );
});

test("the renderers are optional, the core is required (a 404 renderer never kills the boot)", async () => {
  const { OPTIONAL_SCRIPTS, REQUIRED_SCRIPTS } = await import("./assets.ts");
  assert.deepEqual(
    [...REQUIRED_SCRIPTS],
    [
      "/assets/vendor/xterm-5.5.0/xterm.js",
      "/assets/vendor/xterm-5.5.0/addon-fit.js",
      "/assets/vendor/xterm-5.5.0/addon-clipboard.js",
    ],
  );
  assert.deepEqual(
    [...OPTIONAL_SCRIPTS],
    [
      "/assets/vendor/xterm-5.5.0/addon-webgl.js",
      "/assets/vendor/xterm-5.5.0/addon-canvas.js",
    ],
  );
});
