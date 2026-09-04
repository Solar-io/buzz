import assert from "node:assert/strict";
import { test } from "node:test";
import {
  linkPreviewCandidates,
  MAX_CANDIDATES,
} from "./linkPreviewCandidates.ts";

/**
 * Each candidate is an outbound fetch the relay makes on the sender's behalf,
 * and each one has to survive into the sent message byte-for-byte. Both
 * properties are what these vectors are about.
 */

test("plain https links are found in order", () => {
  assert.deepEqual(
    linkPreviewCandidates(
      "see https://a.example/one and https://b.example/two",
    ),
    ["https://a.example/one", "https://b.example/two"],
  );
});

test("every candidate appears verbatim in the content it came from", () => {
  // The relay's ingest check requires the snapshot's canonical URL to be a
  // substring of the message body. A candidate that does not satisfy this
  // cannot produce a sendable tag.
  const content =
    "Read https://example.com/a/(b)_c. Then https://example.com/d?e=f&g=h!";
  const found = linkPreviewCandidates(content);
  assert.ok(found.length > 0);
  for (const href of found) {
    assert.ok(content.includes(href), `${href} is not in the content`);
  }
});

test("trailing sentence punctuation is not part of the link", () => {
  assert.deepEqual(linkPreviewCandidates("go to https://example.com/a."), [
    "https://example.com/a",
  ]);
  assert.deepEqual(linkPreviewCandidates("(see https://example.com/a)"), [
    "https://example.com/a",
  ]);
  // …but a balanced paren really is part of the URL.
  assert.deepEqual(
    linkPreviewCandidates("https://en.wikipedia.org/wiki/Foo_(bar)"),
    ["https://en.wikipedia.org/wiki/Foo_(bar)"],
  );
});

test("http links are not offered", () => {
  // The relay refuses them, so offering one only produces a failure the author
  // cannot act on.
  assert.deepEqual(linkPreviewCandidates("http://example.com/a"), []);
});

test("links inside code are left alone", () => {
  assert.deepEqual(
    linkPreviewCandidates("`https://example.com/a` is the endpoint"),
    [],
  );
  assert.deepEqual(
    linkPreviewCandidates("```\ncurl https://example.com/a\n```"),
    [],
  );
  // Discriminator: the same URL outside code is still found.
  assert.deepEqual(
    linkPreviewCandidates(
      "```\ncurl https://example.com/a\n```\nsee https://example.com/b",
    ),
    ["https://example.com/b"],
  );
});

test("duplicates collapse and the list is capped", () => {
  assert.deepEqual(
    linkPreviewCandidates("https://a.example/x https://a.example/x"),
    ["https://a.example/x"],
  );
  const many = Array.from(
    { length: 9 },
    (_, index) => `https://example.com/p${index}`,
  ).join(" ");
  // Hardcoded 4: an expectation written as MAX_CANDIDATES would move with the
  // constant it is meant to pin.
  assert.equal(linkPreviewCandidates(many).length, 4);
  assert.equal(MAX_CANDIDATES, 4);
});

test("text with no links yields nothing", () => {
  assert.deepEqual(linkPreviewCandidates("just some words"), []);
  assert.deepEqual(linkPreviewCandidates(""), []);
  assert.deepEqual(linkPreviewCandidates("https://"), []);
});
