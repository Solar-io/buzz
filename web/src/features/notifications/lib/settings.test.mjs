import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseNotificationSettings,
  serializeNotificationSettings,
} from "./settings.ts";

// The defaults are asserted literally rather than against
// DEFAULT_NOTIFICATION_SETTINGS: comparing the parser's fallback to the same
// object the parser falls back to cannot fail.
test("nothing stored yields the shipped defaults", () => {
  assert.deepEqual(parseNotificationSettings(null), {
    desktopEnabled: false,
    titleBadgeEnabled: true,
    mode: "mentions",
  });
});

test("desktop notifications are OFF until the user asks for them", () => {
  // Enabling is the gesture permission is requested from, so a default of
  // `true` would mean the app asks on first load.
  assert.equal(parseNotificationSettings(null).desktopEnabled, false);
});

test("a stored record round-trips", () => {
  const settings = {
    desktopEnabled: true,
    titleBadgeEnabled: false,
    mode: "all",
  };
  assert.deepEqual(
    parseNotificationSettings(serializeNotificationSettings(settings)),
    settings,
  );
});

test("a partial record keeps the fields it has", () => {
  const parsed = parseNotificationSettings('{"mode":"none"}');
  assert.equal(parsed.mode, "none");
  assert.equal(parsed.titleBadgeEnabled, true);
  assert.equal(parsed.desktopEnabled, false);
});

test("an unknown mode falls back rather than reaching the decision", () => {
  assert.equal(parseNotificationSettings('{"mode":"loud"}').mode, "mentions");
});

test("wrong types fall back field by field", () => {
  const parsed = parseNotificationSettings(
    '{"desktopEnabled":"yes","titleBadgeEnabled":0,"mode":7}',
  );
  assert.deepEqual(parsed, {
    desktopEnabled: false,
    titleBadgeEnabled: true,
    mode: "mentions",
  });
});

test("malformed and non-object JSON are survivable", () => {
  assert.equal(parseNotificationSettings("{oops").mode, "mentions");
  assert.equal(parseNotificationSettings("[1,2,3]").mode, "mentions");
  assert.equal(parseNotificationSettings("42").mode, "mentions");
  assert.equal(parseNotificationSettings("null").mode, "mentions");
});
