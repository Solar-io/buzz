import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("../../../../..", import.meta.url));
const retired = [
  "AgentConfigPanel",
  "AgentsAdminPage",
  "AgentRosterSidebar",
  "AgentAdminPanel",
];
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((item) =>
    item.isDirectory()
      ? files(path.join(dir, item.name))
      : [path.join(dir, item.name)],
  );
}
test("no source module imports the retired agent pages and all four files are removed", () => {
  assert.ok(files(root).length > 100);
  for (const name of retired)
    assert.equal(
      existsSync(path.join(root, "features/agents/ui", `${name}.tsx`)),
      false,
      name,
    );
  for (const file of files(root).filter((file) => /\.(tsx?|mjs)$/.test(file))) {
    if (file === fileURLToPath(import.meta.url)) continue;
    const source = readFileSync(file, "utf8");
    for (const name of retired)
      assert.doesNotMatch(
        source,
        new RegExp(
          `(?:from\\s*|import\\s*\\()["'][^"']*${name}(?:\\.tsx)?["']`,
        ),
        file,
      );
  }
});
