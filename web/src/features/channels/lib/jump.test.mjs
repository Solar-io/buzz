import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptJumpGhost,
  buildJumpResults,
  JUMP_SCOPES,
  parseJumpQuery,
  recentJumpKeys,
  scopedJumpText,
} from "./jump.ts";

// The Jump artboard's sample set.
const CANDIDATES = [
  {
    key: "conversation:c-flight",
    kind: "channel",
    label: "flight-path",
    hint: "1 needs you",
    hot: true,
  },
  {
    key: "conversation:c-eng",
    kind: "channel",
    label: "engineering",
    hint: "2 agents working",
  },
  {
    key: "conversation:c-ann",
    kind: "channel",
    label: "announcements",
    hint: "unread",
  },
  { key: "conversation:c-design", kind: "channel", label: "design" },
  { key: "conversation:c-general", kind: "channel", label: "general" },
  { key: "conversation:d-gilfoyle", kind: "dm", label: "Gilfoyle" },
  { key: "conversation:d-nikon", kind: "dm", label: "Lord Nikon" },
  { key: "person:p-evie", kind: "person", label: "Evie" },
  {
    key: "command:remind",
    kind: "command",
    label: "remind",
    hint: "/remind [when]",
  },
  {
    key: "action:reminders",
    kind: "action",
    label: "Reminders",
    keywords: ["remind", "later"],
  },
  {
    key: "action:new-channel",
    kind: "action",
    label: "New channel",
    keywords: ["create"],
  },
];

const keys = (results) => results.flat.map((item) => item.key);
const headers = (results) => results.sections.map((section) => section.header);

test("# @ / scope the list; the ghost completes the top prefix hit", () => {
  assert.deepEqual(parseJumpQuery("en"), {
    scope: "all",
    prefix: "",
    needle: "en",
  });
  assert.deepEqual(parseJumpQuery("#En "), {
    scope: "channel",
    prefix: "#",
    needle: "en",
  });
  assert.deepEqual(parseJumpQuery("@lord"), {
    scope: "person",
    prefix: "@",
    needle: "lord",
  });
  assert.deepEqual(parseJumpQuery("/re"), {
    scope: "command",
    prefix: "/",
    needle: "re",
  });
  assert.deepEqual(parseJumpQuery(""), {
    scope: "all",
    prefix: "",
    needle: "",
  });

  // "en": engineering is the prefix hit; the ghost is the rest of its name.
  const all = buildJumpResults({
    query: parseJumpQuery("en"),
    candidates: CANDIDATES,
    recents: [],
  });
  assert.deepEqual(headers(all), ["Top hit", "Channels"]);
  assert.equal(all.flat[0].key, "conversation:c-eng");
  assert.equal(all.ghost, "gineering");
  // Substring hits follow (announcements, general, design? — only matches).
  assert.deepEqual(keys(all), [
    "conversation:c-eng",
    "conversation:c-ann",
    "conversation:c-general",
  ]);
  assert.equal(acceptJumpGhost(parseJumpQuery("en"), all), "engineering");

  // A substring-only top hit offers NO ghost: Tab must not rewrite the text.
  const sub = buildJumpResults({
    query: parseJumpQuery("path"),
    candidates: CANDIDATES,
    recents: [],
  });
  assert.equal(sub.flat[0].key, "conversation:c-flight");
  assert.equal(sub.ghost, "");
  assert.equal(acceptJumpGhost(parseJumpQuery("path"), sub), null);

  // "@" keeps people and DMs only; Tab keeps the sigil.
  const people = buildJumpResults({
    query: parseJumpQuery("@g"),
    candidates: CANDIDATES,
    recents: [],
  });
  assert.deepEqual(keys(people), ["conversation:d-gilfoyle"]);
  assert.equal(people.ghost, "ilfoyle");
  assert.equal(acceptJumpGhost(parseJumpQuery("@g"), people), "@Gilfoyle");

  // "#" keeps channels only — Gilfoyle's DM also matches "g" and is absent.
  // The prefix hit leads; substring hits follow alphabetically.
  const channels = buildJumpResults({
    query: parseJumpQuery("#g"),
    candidates: CANDIDATES,
    recents: [],
  });
  assert.deepEqual(keys(channels), [
    "conversation:c-general",
    "conversation:c-design",
    "conversation:c-eng",
    "conversation:c-flight",
  ]);

  // "/" keeps commands and actions. Two prefix hits tie and sort by label;
  // "New channel" matches through its keyword ("create") and trails them.
  const commands = buildJumpResults({
    query: parseJumpQuery("/re"),
    candidates: CANDIDATES,
    recents: [],
  });
  assert.deepEqual(keys(commands), [
    "command:remind",
    "action:reminders",
    "action:new-channel",
  ]);
  assert.deepEqual(headers(commands), ["Top hit", "Actions"]);
  assert.equal(commands.ghost, "mind");
});

test("empty query lists recents, newest first", () => {
  const results = buildJumpResults({
    query: parseJumpQuery(""),
    candidates: CANDIDATES,
    recents: [
      "conversation:d-nikon",
      "conversation:c-flight",
      "conversation:gone",
      "conversation:c-eng",
    ],
  });
  assert.deepEqual(headers(results), ["Recent"]);
  // In the order opened; a recent that no longer exists is skipped.
  assert.deepEqual(keys(results), [
    "conversation:d-nikon",
    "conversation:c-flight",
    "conversation:c-eng",
  ]);
  assert.equal(results.ghost, "");

  // No history yet: no section at all, rather than an empty "Recent".
  assert.deepEqual(
    buildJumpResults({
      query: parseJumpQuery(""),
      candidates: CANDIDATES,
      recents: [],
    }).sections,
    [],
  );
});

test("a scope with nothing typed lists that scope, grouped", () => {
  const results = buildJumpResults({
    query: parseJumpQuery("/"),
    candidates: CANDIDATES,
    recents: ["conversation:c-eng"],
  });
  assert.deepEqual(headers(results), ["Commands", "Actions"]);
  assert.deepEqual(keys(results), [
    "command:remind",
    "action:new-channel",
    "action:reminders",
  ]);
});

test("no match returns nothing, so the panel can offer message search", () => {
  const results = buildJumpResults({
    query: parseJumpQuery("zzz"),
    candidates: CANDIDATES,
    recents: [],
  });
  assert.deepEqual(results, { sections: [], flat: [], ghost: "" });
});

test("scope chips rewrite the field, keeping what was typed", () => {
  assert.deepEqual(
    JUMP_SCOPES.map((scope) => [scope.id, scope.key]),
    [
      ["all", ""],
      ["channel", "#"],
      ["person", "@"],
      ["command", "/"],
    ],
  );
  assert.equal(scopedJumpText("channel", "en"), "#en");
  assert.equal(scopedJumpText("all", "en"), "en");
});

test("recentJumpKeys orders by last open, not by score, and skips links", () => {
  const visits = {
    "c-eng": { score: 40, at: 1_000 },
    "c-flight": { score: 1, at: 3_000 },
    "link:docs": { score: 9, at: 9_000 },
    "d-nikon": { score: 5, at: 2_000 },
  };
  assert.deepEqual(recentJumpKeys(visits), [
    "conversation:c-flight",
    "conversation:d-nikon",
    "conversation:c-eng",
  ]);
  assert.deepEqual(recentJumpKeys(visits, 1), ["conversation:c-flight"]);
});
