import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseNotificationSettings,
  serializeNotificationSettings,
} from "./settings.ts";

// The defaults are asserted literally rather than against
// DEFAULT_NOTIFICATION_SETTINGS: comparing the parser's fallback to the same
// object the parser falls back to cannot fail.
const SHIPPED_SOUNDS = {
  dm: "unison",
  mention: "ping",
  channel: "doop",
  reminder: "doodone",
};

test("sounds are ON by default", () => {
  assert.equal(parseNotificationSettings(null).soundEnabled, true);
});

test("an old blob without sound fields keeps its fields and gets sound defaults", () => {
  // Exactly what a pre-sound build wrote.
  const parsed = parseNotificationSettings(
    '{"desktopEnabled":true,"titleBadgeEnabled":false,"mode":"all"}',
  );
  assert.deepEqual(parsed, {
    desktopEnabled: true,
    titleBadgeEnabled: false,
    mode: "all",
    soundEnabled: true,
    sounds: SHIPPED_SOUNDS,
  });
});

test("an unknown sound name falls back to THAT slot's default only", () => {
  const parsed = parseNotificationSettings(
    '{"sounds":{"dm":"airhorn","mention":"flutter","channel":7}}',
  );
  assert.deepEqual(parsed.sounds, {
    dm: "unison",
    mention: "flutter",
    channel: "doop",
    reminder: "doodone",
  });
});

test("a non-object sounds field and a non-boolean soundEnabled fall back", () => {
  const parsed = parseNotificationSettings(
    '{"soundEnabled":"no","sounds":["ping"]}',
  );
  assert.equal(parsed.soundEnabled, true);
  assert.deepEqual(parsed.sounds, SHIPPED_SOUNDS);
});

test("soundEnabled false is kept", () => {
  assert.equal(
    parseNotificationSettings('{"soundEnabled":false}').soundEnabled,
    false,
  );
});

test("parsed defaults do not share the sounds object between calls", () => {
  const first = parseNotificationSettings(null);
  first.sounds.dm = "boo";
  assert.equal(parseNotificationSettings(null).sounds.dm, "unison");
});
test("nothing stored yields the shipped defaults", () => {
  assert.deepEqual(parseNotificationSettings(null), {
    desktopEnabled: false,
    titleBadgeEnabled: true,
    mode: "mentions",
    soundEnabled: true,
    sounds: SHIPPED_SOUNDS,
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
    soundEnabled: false,
    sounds: {
      dm: "boo",
      mention: "flutter",
      channel: "oh-no",
      reminder: "bong",
    },
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
    soundEnabled: true,
    sounds: SHIPPED_SOUNDS,
  });
});

test("malformed and non-object JSON are survivable", () => {
  assert.equal(parseNotificationSettings("{oops").mode, "mentions");
  assert.equal(parseNotificationSettings("[1,2,3]").mode, "mentions");
  assert.equal(parseNotificationSettings("42").mode, "mentions");
  assert.equal(parseNotificationSettings("null").mode, "mentions");
});
