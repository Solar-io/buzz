import assert from "node:assert/strict";
import { test } from "node:test";

import { createSignInListener, signInUrl } from "./signIn.ts";

/** W-8: only hatch's own message, from hatch's own origin, re-checks the session. */

const HATCH = "https://crichton.tailb3d4b8.ts.net:6881";

test("hatch's message from hatch's origin re-checks", () => {
  let calls = 0;
  const listener = createSignInListener(HATCH, () => {
    calls += 1;
  });
  listener({ origin: HATCH, data: { type: "hatch:signed-in" } });
  assert.equal(calls, 1);
});

test("the same message from any other origin is ignored", () => {
  let calls = 0;
  const listener = createSignInListener(HATCH, () => {
    calls += 1;
  });
  for (const origin of [
    "https://evil.example",
    "https://crichton.tailb3d4b8.ts.net:6351",
    "https://crichton.tailb3d4b8.ts.net:6881.evil.example",
    "null",
  ]) {
    listener({ origin, data: { type: "hatch:signed-in" } });
  }
  assert.equal(calls, 0);
});

test("other messages from hatch's origin are ignored", () => {
  let calls = 0;
  const listener = createSignInListener(HATCH, () => {
    calls += 1;
  });
  listener({ origin: HATCH, data: "hatch:signed-in" });
  listener({ origin: HATCH, data: { type: "something-else" } });
  listener({ origin: HATCH, data: null });
  assert.equal(calls, 0);
});

test("sign-in opens hatch's GitHub flow with a path-only return", () => {
  assert.equal(
    signInUrl(`${HATCH}/`),
    `${HATCH}/auth/github?redirectTo=%2Fauth%2Fsigned-in`,
  );
});
