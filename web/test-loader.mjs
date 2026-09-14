import { register, registerHooks } from "node:module";

// In-thread hooks (node >= 22.15) so the test files and the resolve/load
// hooks share one `globalThis` — hooks.test.mjs installs module stubs on a
// global the resolver must be able to read. Older runtimes fall back to
// register() (separate loader thread): static behaviour keeps working, but
// the runtime module-stub seam does not.
import * as hooks from "./test-loader-hooks.mjs";

if (typeof registerHooks === "function") {
  registerHooks(hooks);
} else {
  register("./test-loader-hooks.mjs", import.meta.url);
}
