import assert from "node:assert/strict";
import { test } from "node:test";

import {
  searchHighlightTerms,
  searchResultPreview,
  splitSearchMatches,
} from "./searchMatch.ts";

function matched(text, query) {
  return splitSearchMatches(text, query)
    .filter((part) => part.isMatch)
    .map((part) => part.text);
}

function rebuilt(text, query) {
  return splitSearchMatches(text, query)
    .map((part) => part.text)
    .join("");
}

test("a completed token matches exactly, not as a prefix", () => {
  // "foo bar" asks Postgres for foo & bar:* — so "foobar" must not light up
  // for the leading token.
  assert.deepEqual(matched("foobar bar", "foo bar"), ["bar"]);
});

test("the trailing token matches as a prefix", () => {
  assert.deepEqual(matched("deployment", "depl"), ["depl"]);
});

test("punctuation splits lexemes the way Postgres' simple config does", () => {
  assert.deepEqual(matched("foo-bar", "bar"), ["bar"]);
  assert.deepEqual(matched("foo-bar", "foo"), ["foo"]);
});

test("matching is case-insensitive but preserves the original text", () => {
  assert.deepEqual(matched("Deploy the DEPLOYER", "deploy"), [
    "Deploy",
    "DEPLOY",
  ]);
});

test("splitting is lossless — the parts rebuild the input", () => {
  const text = "Deploy: rolled back the deployment, then re-deployed.";
  assert.equal(rebuilt(text, "deploy"), text);
  assert.equal(rebuilt(text, "nothing-here"), text);
});

test("a query that matches nothing yields one unmatched part", () => {
  const parts = splitSearchMatches("hello", "zzz");
  assert.equal(parts.length, 1);
  assert.equal(parts[0].isMatch, false);
});

test("highlight terms are lexemes, deduplicated per mode", () => {
  // Sorted longest-first so a long term wins the span; equal lengths keep
  // their written order.
  assert.deepEqual(searchHighlightTerms("foo-bar baz"), ["foo", "bar", "baz"]);
  assert.deepEqual(searchHighlightTerms("hi deployment"), ["deployment", "hi"]);
  assert.deepEqual(searchHighlightTerms("  "), []);
});

test("a short message is previewed whole", () => {
  assert.equal(searchResultPreview("hello there", "hello"), "hello there");
});

test("a preview keeps the match visible instead of clipping it off", () => {
  const long = `${"lorem ipsum ".repeat(40)}needle tail`;
  const preview = searchResultPreview(long, "needle", 60);
  assert.ok(
    preview.includes("needle"),
    `the match must survive the excerpt: ${preview}`,
  );
  assert.ok(preview.length <= 60, `too long: ${preview.length}`);
  assert.ok(preview.startsWith("…"), "context before the match is elided");
});

test("a preview with no match falls back to the head of the message", () => {
  const long = "a".repeat(300);
  const preview = searchResultPreview(long, "zzz", 50);
  assert.equal(preview.length, 50);
  assert.ok(preview.endsWith("…"));
});

test("an empty message previews as a stated absence, not a blank row", () => {
  assert.equal(searchResultPreview("   ", "x"), "No message body.");
});

test("whitespace is collapsed so a multi-line hit stays one line", () => {
  assert.equal(
    searchResultPreview("one\n\ntwo   three", "two"),
    "one two three",
  );
});
