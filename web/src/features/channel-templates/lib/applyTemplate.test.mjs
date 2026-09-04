import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildAddMemberEvent,
  buildCreateChannelEvent,
  canonicalChannelName,
  canvasBody,
  expandRoster,
} from "./applyTemplate.ts";

const CHANNEL_ID = "6f1a2c40-0000-4000-8000-000000000001";
const PUBKEY_A =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function tagValue(event, name) {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}

// ── canonical_channel_name ──────────────────────────────────────────────────

test("canonical name strips leading hashes and whitespace", () => {
  assert.equal(canonicalChannelName("  ##general "), "general");
});

test("canonical name keeps interior spacing", () => {
  assert.equal(canonicalChannelName("#sprint planning  "), "sprint planning");
});

// ── kind 9007 ───────────────────────────────────────────────────────────────

test("a stream template builds a 9007 with the four required tags", () => {
  const result = buildCreateChannelEvent({
    channelId: CHANNEL_ID,
    name: "#standup",
    template: {
      channelType: "stream",
      visibility: "open",
      description: null,
    },
  });
  assert.ok("event" in result);
  assert.equal(result.event.kind, 9007);
  assert.equal(tagValue(result.event, "h"), CHANNEL_ID);
  assert.equal(tagValue(result.event, "name"), "standup");
  assert.equal(tagValue(result.event, "visibility"), "open");
  assert.equal(tagValue(result.event, "channel_type"), "stream");
  assert.equal(
    result.event.tags.some((tag) => tag[0] === "about"),
    false,
  );
});

/**
 * A forum template must actually emit channel_type=forum. This is the value
 * that discriminates: the web client's own New Channel dialog omits the tag
 * entirely, so "stream" is what you get by doing nothing.
 */
test("a forum template emits channel_type forum, not the stream default", () => {
  const result = buildCreateChannelEvent({
    channelId: CHANNEL_ID,
    name: "rfcs",
    template: {
      channelType: "forum",
      visibility: "private",
      description: "Design discussions",
    },
  });
  assert.ok("event" in result);
  assert.equal(tagValue(result.event, "channel_type"), "forum");
  assert.equal(tagValue(result.event, "visibility"), "private");
  assert.equal(tagValue(result.event, "about"), "Design discussions");
});

test("no template falls back to an open stream", () => {
  const result = buildCreateChannelEvent({
    channelId: CHANNEL_ID,
    name: "adhoc",
    template: null,
  });
  assert.ok("event" in result);
  assert.equal(tagValue(result.event, "channel_type"), "stream");
  assert.equal(tagValue(result.event, "visibility"), "open");
});

test("a name that canonicalises to nothing is an error, not an event", () => {
  const result = buildCreateChannelEvent({
    channelId: CHANNEL_ID,
    name: "###",
    template: null,
  });
  assert.deepEqual(result, { error: "channel name is required" });
});

// ── kind 9000 ───────────────────────────────────────────────────────────────

test("add-member builds a 9000 with h, p and the bot role", () => {
  const result = buildAddMemberEvent({
    channelId: CHANNEL_ID,
    pubkey: PUBKEY_A.toUpperCase(),
    role: "bot",
  });
  assert.ok("event" in result);
  assert.equal(result.event.kind, 9000);
  assert.equal(tagValue(result.event, "h"), CHANNEL_ID);
  // Lowercased, matching build_add_member's to_ascii_lowercase.
  assert.equal(tagValue(result.event, "p"), PUBKEY_A);
  assert.equal(tagValue(result.event, "role"), "bot");
});

test('the "member" role is sent as no role tag at all', () => {
  const result = buildAddMemberEvent({
    channelId: CHANNEL_ID,
    pubkey: PUBKEY_A,
    role: "member",
  });
  assert.ok("event" in result);
  assert.equal(
    result.event.tags.some((tag) => tag[0] === "role"),
    false,
  );
});

test("a malformed pubkey is refused before it reaches the relay", () => {
  const result = buildAddMemberEvent({ channelId: CHANNEL_ID, pubkey: "abc" });
  assert.deepEqual(result, {
    error: "target_pubkey must be 64 hex characters",
  });
});

// ── roster expansion ────────────────────────────────────────────────────────

const CATALOG = {
  personas: [
    {
      id: "builtin:fizz",
      name: "Fizz",
      systemPrompt: "Be helpful.",
      model: "sonnet",
      provider: "anthropic",
      runtime: "claude",
    },
    {
      id: "builtin:honey",
      name: "Honey",
      systemPrompt: "Be thorough.",
      model: "",
      provider: "",
      runtime: "codex",
    },
  ],
  teams: [{ id: "team-1", personaIds: ["builtin:fizz", "builtin:honey"] }],
};

function roster(overrides = {}) {
  return { personas: [], teams: [], ...overrides };
}

test("a direct persona entry becomes one spec carrying the persona's prompt", () => {
  const { specs, skipped } = expandRoster(
    roster({
      personas: [
        {
          personaId: "builtin:fizz",
          runtime: null,
          model: null,
          role: null,
          backend: null,
        },
      ],
    }),
    CATALOG,
  );
  assert.equal(specs.length, 1);
  assert.deepEqual(skipped, []);
  assert.equal(specs[0].name, "Fizz");
  assert.equal(specs[0].systemPrompt, "Be helpful.");
  assert.equal(specs[0].role, "bot");
});

/**
 * The entry override must win over the persona's own value. Fizz's persona
 * pins model "sonnet" and runtime "claude"; the entry asks for "opus" on
 * "gemini". Both sides differ, so an implementation that ignored the override
 * would still be caught.
 */
test("an entry's runtime and model override the persona's own", () => {
  const { specs } = expandRoster(
    roster({
      personas: [
        {
          personaId: "builtin:fizz",
          runtime: "gemini",
          model: "opus",
          role: null,
          backend: null,
        },
      ],
    }),
    CATALOG,
  );
  assert.equal(specs[0].model, "opus");
  assert.deepEqual(specs[0].harness, { kind: "preset", runtimeId: "gemini" });
});

test("a provider backend overrides the persona's provider", () => {
  const { specs } = expandRoster(
    roster({
      personas: [
        {
          personaId: "builtin:fizz",
          runtime: null,
          model: null,
          role: null,
          backend: { type: "provider", id: "openrouter" },
        },
      ],
    }),
    CATALOG,
  );
  assert.equal(specs[0].provider, "openrouter");
});

test("a local backend leaves the persona's provider in place", () => {
  const { specs } = expandRoster(
    roster({
      personas: [
        {
          personaId: "builtin:fizz",
          runtime: null,
          model: null,
          role: null,
          backend: { type: "local" },
        },
      ],
    }),
    CATALOG,
  );
  assert.equal(specs[0].provider, "anthropic");
});

test("a persona with no model or provider omits both fields", () => {
  const { specs } = expandRoster(
    roster({
      personas: [
        {
          personaId: "builtin:honey",
          runtime: null,
          model: null,
          role: null,
          backend: null,
        },
      ],
    }),
    CATALOG,
  );
  assert.equal("model" in specs[0], false);
  assert.equal("provider" in specs[0], false);
});

test("a team expands to each of its personas", () => {
  const { specs } = expandRoster(
    roster({
      teams: [{ teamId: "team-1", runtime: null, model: null, backend: null }],
    }),
    CATALOG,
  );
  assert.equal(specs.length, 2);
  assert.deepEqual(
    specs.map((s) => s.name),
    ["Fizz", "Honey"],
  );
});

/**
 * The de-dupe has to span both passes: a persona listed directly AND inside a
 * team must be provisioned once. Counting the specs is the assertion that
 * fails if the two loops keep separate `seen` sets.
 */
test("a persona named directly and via a team is provisioned once", () => {
  const { specs } = expandRoster(
    roster({
      personas: [
        {
          personaId: "builtin:fizz",
          runtime: null,
          model: null,
          role: null,
          backend: null,
        },
      ],
      teams: [{ teamId: "team-1", runtime: null, model: null, backend: null }],
    }),
    CATALOG,
  );
  assert.equal(specs.length, 2);
  assert.equal(specs.filter((s) => s.personaId === "builtin:fizz").length, 1);
});

test("the direct entry wins the de-dupe, keeping its override", () => {
  const { specs } = expandRoster(
    roster({
      personas: [
        {
          personaId: "builtin:fizz",
          runtime: null,
          model: "haiku",
          role: null,
          backend: null,
        },
      ],
      teams: [
        { teamId: "team-1", runtime: null, model: "opus", backend: null },
      ],
    }),
    CATALOG,
  );
  const fizz = specs.find((s) => s.personaId === "builtin:fizz");
  assert.equal(fizz.model, "haiku");
});

test("an unknown persona or team is reported as skipped, not thrown", () => {
  const { specs, skipped } = expandRoster(
    roster({
      personas: [
        {
          personaId: "ghost",
          runtime: null,
          model: null,
          role: null,
          backend: null,
        },
      ],
      teams: [{ teamId: "no-team", runtime: null, model: null, backend: null }],
    }),
    CATALOG,
  );
  assert.deepEqual(specs, []);
  assert.deepEqual(skipped.sort(), ["ghost", "no-team"]);
});

// ── canvas interpolation ────────────────────────────────────────────────────

test("canvas interpolation replaces every occurrence of both tokens", () => {
  const body = canvasBody(
    {
      name: "Sprint",
      canvasTemplate: "# {channel.name}\n{template.name} for {channel.name}",
    },
    "week-32",
  );
  assert.equal(body, "# week-32\nSprint for week-32");
});

test("a template with no canvas interpolates to null", () => {
  assert.equal(canvasBody({ name: "n", canvasTemplate: null }, "c"), null);
});
