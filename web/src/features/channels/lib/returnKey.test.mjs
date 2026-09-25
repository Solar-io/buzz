import assert from "node:assert/strict";
import { test } from "node:test";

import { returnInsertsNewline } from "./returnKey.ts";

// A fake matchMedia that evaluates the two features this query uses.
function device({ coarse, width }) {
  return (query) => {
    const wantsCoarse = query.includes("(pointer: coarse)");
    const max = /max-width:\s*(\d+)px/.exec(query);
    const widthOk = max ? width <= Number(max[1]) : true;
    return { matches: (!wantsCoarse || coarse) && widthOk };
  };
}

test("phone: Return inserts a newline", () => {
  assert.equal(returnInsertsNewline(device({ coarse: true, width: 390 })), true);
});

test("iPad landscape and portrait: Return sends", () => {
  assert.equal(returnInsertsNewline(device({ coarse: true, width: 1180 })), false);
  assert.equal(returnInsertsNewline(device({ coarse: true, width: 820 })), false);
  assert.equal(returnInsertsNewline(device({ coarse: true, width: 768 })), false);
});

test("desktop: Return sends", () => {
  assert.equal(returnInsertsNewline(device({ coarse: false, width: 390 })), false);
  assert.equal(returnInsertsNewline(device({ coarse: false, width: 1440 })), false);
});

test("no matchMedia: Return sends", () => {
  assert.equal(returnInsertsNewline(undefined), false);
});
