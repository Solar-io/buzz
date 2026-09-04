import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import test from "node:test";

/**
 * Every authenticated relay HTTP caller goes through `nip98Headers`.
 *
 * This is a source scan, which normally proves nothing about behaviour — but
 * the defect it guards is precisely an omission, and an omission has no
 * runtime to observe. On 2026-09-04 seven of ten callers built the header set
 * by hand and left out `x-auth-tag`; the relay reads it for membership AND for
 * the NIP-OA owner fallback, so the moderation queue 403'd for the very owner
 * it was built for, with no hint which header was missing.
 *
 * A new caller that hand-rolls `Authorization` will fail here rather than in
 * production.
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** The helper itself is the one place allowed to mint the raw header. */
const ALLOWED = new Set(["shared/lib/nip98.ts"]);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\./.test(entry)) out.push(full);
  }
  return out;
}

test("no caller mints a NIP-98 header without the auth tag", () => {
  const offenders = [];
  for (const file of walk(SRC)) {
    const rel = relative(SRC, file).split("\\").join("/");
    if (ALLOWED.has(rel)) continue;
    const source = readFileSync(file, "utf8");
    if (source.includes("makeNip98AuthHeader")) offenders.push(rel);
  }
  assert.deepEqual(
    offenders,
    [],
    `these call makeNip98AuthHeader directly and so omit x-auth-tag; use nip98Headers instead:\n  ${offenders.join("\n  ")}`,
  );
});

test("the scan actually looks at the tree it claims to", () => {
  // Guard against the walk silently returning nothing, which would make the
  // assertion above vacuous.
  const files = walk(SRC);
  assert.ok(
    files.length > 200,
    `expected a full source tree, saw ${files.length}`,
  );
  assert.ok(files.some((f) => f.endsWith("shared/lib/nip98.ts")));
});
