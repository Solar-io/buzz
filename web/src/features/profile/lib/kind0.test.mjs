import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EMPTY_PROFILE_METADATA,
  parseProfileContent,
  parseProfileObject,
  pickLatestProfileEvent,
  profileLabel,
  serializeProfileContent,
} from "./kind0.ts";

test("parseProfileContent reads the NIP-01 field names", () => {
  const metadata = parseProfileContent(
    JSON.stringify({
      name: "sam",
      display_name: "Sam Gallant",
      about: "Builds things.",
      picture: "https://relay.example/blob/abc.png",
      nip05: "sam@example.com",
      website: "https://example.com",
    }),
  );
  assert.deepEqual(metadata, {
    name: "sam",
    displayName: "Sam Gallant",
    about: "Builds things.",
    picture: "https://relay.example/blob/abc.png",
    nip05: "sam@example.com",
    website: "https://example.com",
  });
});

test("parseProfileContent ignores non-string values instead of rendering them", () => {
  // A relay peer can publish anything here; `{name: 42}` must not reach a
  // component that will call `.trim()` on it.
  const metadata = parseProfileContent(
    JSON.stringify({ name: 42, display_name: null, about: ["a"] }),
  );
  assert.equal(metadata.name, "");
  assert.equal(metadata.displayName, "");
  assert.equal(metadata.about, "");
});

test("parseProfileContent degrades to an empty profile, never throws", () => {
  for (const content of ["", "not json", "3", '"a string"', "[1,2]", "null"]) {
    assert.deepEqual(
      parseProfileContent(content),
      EMPTY_PROFILE_METADATA,
      `content ${JSON.stringify(content)} should parse as empty`,
    );
  }
});

test("parseProfileObject rejects arrays and scalars, accepts objects", () => {
  assert.equal(parseProfileObject("[1]"), null);
  assert.equal(parseProfileObject("3"), null);
  assert.equal(parseProfileObject("null"), null);
  assert.deepEqual(parseProfileObject('{"a":1}'), { a: 1 });
});

test("profileLabel prefers display_name, then name, then the fallback", () => {
  assert.equal(
    profileLabel(
      { ...EMPTY_PROFILE_METADATA, displayName: "Ada", name: "ada" },
      "abcd…wxyz",
    ),
    "Ada",
  );
  assert.equal(
    profileLabel({ ...EMPTY_PROFILE_METADATA, name: "ada" }, "abcd…wxyz"),
    "ada",
  );
  assert.equal(profileLabel(EMPTY_PROFILE_METADATA, "abcd…wxyz"), "abcd…wxyz");
});

test("profileLabel treats a whitespace-only name as absent", () => {
  assert.equal(
    profileLabel(
      { ...EMPTY_PROFILE_METADATA, displayName: "   " },
      "abcd…wxyz",
    ),
    "abcd…wxyz",
  );
});

test("serializeProfileContent preserves fields this client does not model", () => {
  // The whole point of merging: kind 0 is replaceable, so a publish that
  // dropped lud16/banner would delete them for every other client.
  const previous = JSON.stringify({
    display_name: "Old Name",
    lud16: "sam@getalby.com",
    banner: "https://example.com/banner.png",
    nip05: "sam@example.com",
  });
  const content = serializeProfileContent(
    { displayName: "New Name", about: "Hi", picture: "" },
    previous,
  );
  const parsed = JSON.parse(content);
  assert.equal(parsed.lud16, "sam@getalby.com");
  assert.equal(parsed.banner, "https://example.com/banner.png");
  assert.equal(parsed.nip05, "sam@example.com");
  assert.equal(parsed.display_name, "New Name");
  assert.equal(parsed.about, "Hi");
});

test("serializeProfileContent removes a cleared field rather than writing an empty string", () => {
  const previous = JSON.stringify({
    display_name: "Sam",
    about: "Old bio",
    picture: "https://example.com/a.png",
  });
  const parsed = JSON.parse(
    serializeProfileContent(
      { displayName: "Sam", about: "  ", picture: "" },
      previous,
    ),
  );
  assert.equal("about" in parsed, false);
  assert.equal("picture" in parsed, false);
  assert.equal(parsed.display_name, "Sam");
});

test("serializeProfileContent trims what it writes", () => {
  const parsed = JSON.parse(
    serializeProfileContent(
      { displayName: "  Sam  ", about: "  bio  ", picture: " u " },
      null,
    ),
  );
  assert.equal(parsed.display_name, "Sam");
  assert.equal(parsed.about, "bio");
  assert.equal(parsed.picture, "u");
});

test("serializeProfileContent seeds `name` only when there was none", () => {
  const seeded = JSON.parse(
    serializeProfileContent(
      { displayName: "Sam", about: "", picture: "" },
      null,
    ),
  );
  assert.equal(seeded.name, "Sam");

  const kept = JSON.parse(
    serializeProfileContent(
      { displayName: "Sam Gallant", about: "", picture: "" },
      JSON.stringify({ name: "sam", display_name: "Sam" }),
    ),
  );
  assert.equal(kept.name, "sam", "an existing handle must survive an edit");
  assert.equal(kept.display_name, "Sam Gallant");
});

test("serializeProfileContent survives unparseable previous content", () => {
  const parsed = JSON.parse(
    serializeProfileContent(
      { displayName: "Sam", about: "", picture: "" },
      "}{ not json",
    ),
  );
  assert.deepEqual(parsed, { display_name: "Sam", name: "Sam" });
});

test("pickLatestProfileEvent keeps the newest event, not the first seen", () => {
  const older = { pubkey: "aa", created_at: 100, content: "{}" };
  const newer = { pubkey: "aa", created_at: 200, content: '{"about":"new"}' };

  // Arrival order must not matter — relays replay replaceable events out of
  // order, and the edit form republishes whatever this picks.
  assert.equal(pickLatestProfileEvent(null, older), older);
  assert.equal(pickLatestProfileEvent(older, newer), newer);
  assert.equal(pickLatestProfileEvent(newer, older), newer);
});

test("pickLatestProfileEvent breaks a same-second tie toward the incoming event", () => {
  const first = { pubkey: "aa", created_at: 100, content: '{"about":"first"}' };
  const second = {
    pubkey: "aa",
    created_at: 100,
    content: '{"about":"second"}',
  };
  assert.equal(pickLatestProfileEvent(first, second), second);
});
