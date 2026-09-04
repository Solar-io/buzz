import assert from "node:assert/strict";
import { test } from "node:test";
import {
  featureById,
  parseFeatureState,
  resolveEnabled,
  WEB_FEATURES,
  withFeature,
} from "./featureFlags.ts";
import {
  isApplePlatform,
  keysFor,
  SHORTCUT_CATEGORIES,
} from "./keyboardShortcuts.ts";
import {
  DEFAULT_INVITE_TTL_SECS,
  describeTtl,
  MAX_INVITE_TTL_SECS,
  MAX_INVITE_USES,
  MIN_INVITE_TTL_SECS,
  parseMintedInvite,
  TTL_PRESETS,
  validateMintRequest,
} from "./inviteMint.ts";

// ── feature gates ───────────────────────────────────────────────────────────

test("the manifest carries the channel-templates gate under the desktop's id", () => {
  const feature = featureById("channel-templates");
  assert.ok(feature);
  assert.equal(feature.defaultEnabled, false);
});

/**
 * Fail-open on an unknown id is the property that stops a renamed gate from
 * hiding shipped code. The two cases below differ ONLY in whether the id is in
 * the manifest, so an implementation that defaulted everything to false would
 * pass the first and fail the second.
 */
test("a manifest id is off by default, an unknown id renders", () => {
  assert.equal(resolveEnabled("channel-templates", {}), false);
  assert.equal(resolveEnabled("not-in-the-manifest", {}), true);
});

test("a stored choice overrides the definition default in both directions", () => {
  assert.equal(
    resolveEnabled("channel-templates", { "channel-templates": true }),
    true,
  );
  assert.equal(
    resolveEnabled("channel-templates", { "channel-templates": false }),
    false,
  );
});

test("withFeature does not mutate the state it was given", () => {
  const before = {};
  const after = withFeature(before, "channel-templates", true);
  assert.deepEqual(before, {});
  assert.equal(after["channel-templates"], true);
});

test("persisted state drops unknown ids and non-booleans", () => {
  const parsed = parseFeatureState({
    "channel-templates": true,
    "ghost-feature": true,
    "channel-templates-2": "yes",
  });
  assert.deepEqual(parsed, { "channel-templates": true });
});

test("garbage persisted state parses to an empty object", () => {
  assert.deepEqual(parseFeatureState(null), {});
  assert.deepEqual(parseFeatureState("nope"), {});
});

test("every manifest entry has the fields the card renders", () => {
  assert.ok(WEB_FEATURES.length > 0);
  for (const feature of WEB_FEATURES) {
    assert.equal(typeof feature.id, "string");
    assert.ok(feature.name.length > 0, feature.id);
    assert.ok(feature.description.length > 0, feature.id);
    assert.equal(typeof feature.defaultEnabled, "boolean");
  }
});

// ── keyboard shortcuts ──────────────────────────────────────────────────────

test("platform detection matches useZoomShortcuts", () => {
  assert.equal(isApplePlatform("MacIntel"), true);
  assert.equal(isApplePlatform("iPhone"), true);
  assert.equal(isApplePlatform("Win32"), false);
  assert.equal(isApplePlatform("Linux x86_64"), false);
});

/**
 * The two platforms must actually differ for a modifier shortcut, otherwise
 * the platform branch is untested by construction.
 */
test("a modifier shortcut renders Command on Mac and Ctrl elsewhere", () => {
  const quickSwitcher = SHORTCUT_CATEGORIES.flatMap(
    (category) => category.shortcuts,
  ).find((shortcut) => shortcut.id === "quick-switcher");
  assert.ok(quickSwitcher);
  assert.deepEqual(keysFor(quickSwitcher, "MacIntel"), ["⌘", "K"]);
  assert.deepEqual(keysFor(quickSwitcher, "Win32"), ["Ctrl", "K"]);
});

test("a platform-neutral shortcut reads the same on both", () => {
  const send = SHORTCUT_CATEGORIES.flatMap((c) => c.shortcuts).find(
    (shortcut) => shortcut.id === "send",
  );
  assert.deepEqual(keysFor(send, "MacIntel"), keysFor(send, "Win32"));
});

test("every listed shortcut has both platform strings and a unique id", () => {
  const all = SHORTCUT_CATEGORIES.flatMap((category) => category.shortcuts);
  assert.ok(all.length > 0);
  const ids = new Set();
  for (const shortcut of all) {
    assert.ok(shortcut.mac.length > 0, shortcut.id);
    assert.ok(shortcut.other.length > 0, shortcut.id);
    assert.equal(ids.has(shortcut.id), false, `duplicate ${shortcut.id}`);
    ids.add(shortcut.id);
  }
  assert.equal(ids.size, all.length);
});

// ── invite minting ──────────────────────────────────────────────────────────

test("the bounds match buzz-core/src/invite.rs", () => {
  assert.equal(MIN_INVITE_TTL_SECS, 60);
  assert.equal(DEFAULT_INVITE_TTL_SECS, 259_200);
  assert.equal(MAX_INVITE_TTL_SECS, 2_592_000);
  assert.equal(MAX_INVITE_USES, 10_000);
});

test("an empty request is valid and means the relay's defaults", () => {
  assert.equal(validateMintRequest({}), null);
});

test("a ttl below the minimum or above the maximum is refused", () => {
  assert.match(validateMintRequest({ ttlSecs: 59 }) ?? "", /ttl_secs must be/);
  assert.match(
    validateMintRequest({ ttlSecs: 2_592_001 }) ?? "",
    /ttl_secs must be/,
  );
});

test("the exact bounds are accepted", () => {
  assert.equal(validateMintRequest({ ttlSecs: MIN_INVITE_TTL_SECS }), null);
  assert.equal(validateMintRequest({ ttlSecs: MAX_INVITE_TTL_SECS }), null);
});

test("a non-integer ttl is refused", () => {
  assert.match(
    validateMintRequest({ ttlSecs: 90.5 }) ?? "",
    /ttl_secs must be/,
  );
});

test("max_uses of null means unlimited and is valid", () => {
  assert.equal(validateMintRequest({ maxUses: null }), null);
});

test("max_uses outside 1..=10000 is refused", () => {
  assert.match(validateMintRequest({ maxUses: 0 }) ?? "", /max_uses must be/);
  assert.match(
    validateMintRequest({ maxUses: 10_001 }) ?? "",
    /max_uses must be/,
  );
  assert.equal(validateMintRequest({ maxUses: 1 }), null);
  assert.equal(validateMintRequest({ maxUses: MAX_INVITE_USES }), null);
});

test("every ttl preset is inside the relay's accepted range", () => {
  assert.ok(TTL_PRESETS.length > 0);
  for (const preset of TTL_PRESETS) {
    assert.equal(
      validateMintRequest({ ttlSecs: preset }),
      null,
      String(preset),
    );
  }
});

test("the relay's response shape parses into the view model", () => {
  const invite = parseMintedInvite({
    code: "abc123",
    expires_at: 1_800_000_000,
    max_uses: 5,
    uses_remaining: 5,
    url: "https://buzz.example/invite/abc123",
  });
  assert.ok(invite);
  assert.equal(invite.code, "abc123");
  assert.equal(invite.expiresAt, 1_800_000_000);
  assert.equal(invite.maxUses, 5);
  assert.equal(invite.url, "https://buzz.example/invite/abc123");
});

test("an unlimited invite parses with nulls, not zeros", () => {
  const invite = parseMintedInvite({
    code: "x",
    expires_at: 1,
    max_uses: null,
    uses_remaining: null,
    url: "u",
  });
  assert.equal(invite.maxUses, null);
  assert.equal(invite.usesRemaining, null);
});

test("a response missing the code or url does not parse", () => {
  assert.equal(parseMintedInvite({ url: "u" }), null);
  assert.equal(parseMintedInvite({ code: "c" }), null);
  assert.equal(parseMintedInvite(null), null);
});

test("ttl descriptions pick the largest whole unit", () => {
  assert.equal(describeTtl(3_600), "1 hour");
  assert.equal(describeTtl(7_200), "2 hours");
  assert.equal(describeTtl(86_400), "1 day");
  assert.equal(describeTtl(DEFAULT_INVITE_TTL_SECS), "3 days");
  assert.equal(describeTtl(MAX_INVITE_TTL_SECS), "30 days");
  assert.equal(describeTtl(60), "1 minute");
});
