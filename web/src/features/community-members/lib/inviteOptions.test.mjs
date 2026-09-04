import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_INVITE_TTL_SECS,
  INVITE_TTL_OPTIONS,
  MAX_INVITE_TTL_SECS,
  MAX_INVITE_USES,
  MIN_INVITE_TTL_SECS,
  inviteUrlForCode,
  mintInviteBody,
  mintedInviteFromResponse,
  validateInviteOptions,
} from "./inviteOptions.ts";

test("the bounds are the relay's own numbers", () => {
  // Hardcoded, not derived: crates/buzz-core/src/invite.rs.
  assert.equal(MIN_INVITE_TTL_SECS, 60);
  assert.equal(MAX_INVITE_TTL_SECS, 2_592_000);
  assert.equal(MAX_INVITE_USES, 10_000);
  assert.equal(DEFAULT_INVITE_TTL_SECS, 259_200, "the relay's 72h default");
});

test("every offered TTL is inside the relay's accepted range", () => {
  assert.ok(INVITE_TTL_OPTIONS.length > 0);
  for (const option of INVITE_TTL_OPTIONS) {
    assert.equal(
      validateInviteOptions({ ttlSecs: option.value, maxUses: null }),
      null,
      `${option.label} must be acceptable`,
    );
  }
});

test("validateInviteOptions rejects out-of-range lifetimes", () => {
  assert.match(
    validateInviteOptions({ ttlSecs: 59, maxUses: null }),
    /between 60 seconds and 30 days/,
  );
  assert.match(
    validateInviteOptions({ ttlSecs: MAX_INVITE_TTL_SECS + 1, maxUses: null }),
    /between 60 seconds and 30 days/,
  );
  assert.match(
    validateInviteOptions({ ttlSecs: 3_600.5, maxUses: null }),
    /between 60 seconds and 30 days/,
  );
});

test("validateInviteOptions rejects a non-integer or out-of-range use cap", () => {
  assert.equal(
    validateInviteOptions({ ttlSecs: DEFAULT_INVITE_TTL_SECS, maxUses: 1 }),
    null,
  );
  assert.match(
    validateInviteOptions({ ttlSecs: DEFAULT_INVITE_TTL_SECS, maxUses: 0 }),
    /whole number from 1/,
  );
  assert.match(
    validateInviteOptions({ ttlSecs: DEFAULT_INVITE_TTL_SECS, maxUses: 2.5 }),
    /whole number from 1/,
  );
  assert.match(
    validateInviteOptions({
      ttlSecs: DEFAULT_INVITE_TTL_SECS,
      maxUses: MAX_INVITE_USES + 1,
    }),
    /whole number from 1/,
  );
});

test("an unlimited invite omits max_uses entirely", () => {
  // Sending `"max_uses": null` and omitting it mean the same thing to the
  // relay's serde default, but omission is what the desktop sends and what
  // the endpoint's tests cover.
  assert.equal(
    mintInviteBody({ ttlSecs: 3_600, maxUses: null }),
    '{"ttl_secs":3600}',
  );
  assert.equal(
    mintInviteBody({ ttlSecs: 3_600, maxUses: 5 }),
    '{"ttl_secs":3600,"max_uses":5}',
  );
});

test("mintedInviteFromResponse reads the relay's contract", () => {
  assert.deepEqual(
    mintedInviteFromResponse({
      code: "v2.abc",
      expires_at: 1_700_000_000,
      max_uses: 5,
      uses_remaining: 4,
      url: "https://relay.example/invite/v2.abc",
    }),
    {
      code: "v2.abc",
      url: "https://relay.example/invite/v2.abc",
      expiresAt: 1_700_000_000,
      maxUses: 5,
      usesRemaining: 4,
    },
  );
});

test("an unlimited invite comes back with null counts, not zero", () => {
  const minted = mintedInviteFromResponse({
    code: "v2.abc",
    expires_at: 1,
    max_uses: null,
    uses_remaining: null,
    url: "",
  });
  assert.equal(minted.maxUses, null);
  assert.equal(minted.usesRemaining, null);
});

test("a response without a code is not an invite", () => {
  assert.equal(mintedInviteFromResponse(null), null);
  assert.equal(mintedInviteFromResponse("v2.abc"), null);
  assert.equal(mintedInviteFromResponse({ url: "x" }), null);
  assert.equal(mintedInviteFromResponse({ code: "" }), null);
});

test("inviteUrlForCode builds a same-origin link and escapes the code", () => {
  assert.equal(
    inviteUrlForCode("https://buzz.example/", "v2.abc"),
    "https://buzz.example/invite/v2.abc",
  );
  assert.equal(
    inviteUrlForCode("https://buzz.example", "a/b?c"),
    "https://buzz.example/invite/a%2Fb%3Fc",
  );
});
