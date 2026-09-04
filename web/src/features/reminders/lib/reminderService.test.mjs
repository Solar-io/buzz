import assert from "node:assert/strict";
import { test } from "node:test";

import {
  cancelReminder,
  completeReminder,
  createReminder,
  decryptReminder,
  fetchReminders,
  snoozeReminder,
} from "./reminderService.ts";

const SELF = "aa".repeat(32);

/**
 * A fake NIP-44: the "ciphertext" is the plaintext with a marker prefix, so a
 * test can read what the service actually sealed. Decryption refuses anything
 * without the marker, which is how "a reminder this key cannot open" is
 * exercised without a second keypair.
 */
const MARKER = "sealed:";
function fakeCrypto(overrides = {}) {
  const signed = [];
  const crypto = {
    signed,
    encryptToSelf: (plaintext, pubkey) => {
      assert.equal(pubkey, SELF, "sealed to the wrong key");
      return MARKER + plaintext;
    },
    decryptFromSelf: (ciphertext, pubkey) => {
      assert.equal(pubkey, SELF, "opened with the wrong key");
      if (!ciphertext.startsWith(MARKER)) {
        throw new Error("cannot decrypt");
      }
      return ciphertext.slice(MARKER.length);
    },
    sign: async (template) => {
      const event = {
        ...template,
        created_at: template.created_at ?? 1,
        id: `evt-${signed.length}`,
        pubkey: SELF,
        sig: "f".repeat(128),
      };
      signed.push(event);
      return event;
    },
    ...overrides,
  };
  return crypto;
}

/** A relay that answers one REQ with `events` and records what was published. */
function fakeSession(events = []) {
  const filters = [];
  const published = [];
  return {
    filters,
    published,
    publishResult: { ok: true, message: "" },
    subscribe(filter, options) {
      filters.push(filter);
      for (const event of events) {
        options.onEvent(event);
      }
      options.onEose?.();
      return () => {};
    },
    async publish(event) {
      published.push(event);
      return this.publishResult;
    },
  };
}

function reminderEvent({ id, dTag, notBefore, createdAt, payload }) {
  const tags = [["d", dTag]];
  if (notBefore !== undefined) {
    tags.push(["not_before", String(notBefore)]);
  }
  return {
    id,
    pubkey: SELF,
    kind: 30300,
    created_at: createdAt,
    tags,
    content: MARKER + JSON.stringify(payload),
    sig: "f".repeat(128),
  };
}

function tagValue(tags, name) {
  const found = tags.filter((tag) => tag[0] === name);
  return found.length === 1 ? found[0][1] : undefined;
}

test("decryptReminder reads d tag, not_before and content", () => {
  const reminder = decryptReminder(
    reminderEvent({
      id: "e1",
      dTag: "d1",
      notBefore: 1_770_000_000,
      createdAt: 1_769_000_000,
      payload: { status: "pending", note: "hello" },
    }),
    SELF,
    fakeCrypto(),
  );
  assert.equal(reminder.id, "d1");
  assert.equal(reminder.eventId, "e1");
  assert.equal(reminder.notBefore, 1_770_000_000);
  assert.equal(reminder.createdAt, 1_769_000_000);
  assert.equal(reminder.content.note, "hello");
});

test("decryptReminder returns null for ciphertext this key cannot open", () => {
  const event = reminderEvent({
    id: "e1",
    dTag: "d1",
    createdAt: 1,
    payload: { status: "pending", note: "x" },
  });
  event.content = "someone-elses-ciphertext";
  assert.equal(decryptReminder(event, SELF, fakeCrypto()), null);
});

test("decryptReminder returns null when the d tag is missing", () => {
  const event = reminderEvent({
    id: "e1",
    dTag: "d1",
    createdAt: 1,
    payload: { status: "pending", note: "x" },
  });
  event.tags = event.tags.filter((tag) => tag[0] !== "d");
  assert.equal(decryptReminder(event, SELF, fakeCrypto()), null);
});

test("fetchReminders sends an author-scoped 30300 filter", async () => {
  // The relay refuses a 30300-only REQ without authors=[self]
  // (author_only_filters_authorized, crates/buzz-relay/src/handlers/req.rs).
  const session = fakeSession([]);
  await fetchReminders(session, SELF, fakeCrypto());
  assert.equal(session.filters.length, 1);
  assert.deepEqual(session.filters[0].kinds, [30300]);
  assert.deepEqual(session.filters[0].authors, [SELF]);
});

test("fetchReminders returns only the replacement head per address", async () => {
  const session = fakeSession([
    reminderEvent({
      id: "old",
      dTag: "d1",
      notBefore: 100,
      createdAt: 10,
      payload: { status: "pending", note: "first" },
    }),
    reminderEvent({
      id: "new",
      dTag: "d1",
      notBefore: 900,
      createdAt: 20,
      payload: { status: "pending", note: "snoozed" },
    }),
  ]);
  const reminders = await fetchReminders(session, SELF, fakeCrypto());
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].eventId, "new");
  assert.equal(reminders[0].notBefore, 900);
});

test("fetchReminders drops undecryptable and malformed events, keeps the rest", async () => {
  const good = reminderEvent({
    id: "good",
    dTag: "d-good",
    notBefore: 100,
    createdAt: 10,
    payload: { status: "pending", note: "keep" },
  });
  const undecryptable = reminderEvent({
    id: "bad",
    dTag: "d-bad",
    createdAt: 10,
    payload: { status: "pending", note: "x" },
  });
  undecryptable.content = "not-sealed";
  const malformed = reminderEvent({
    id: "worse",
    dTag: "d-worse",
    createdAt: 10,
    payload: { status: "made-up" },
  });

  const reminders = await fetchReminders(
    fakeSession([good, undecryptable, malformed]),
    SELF,
    fakeCrypto(),
  );
  assert.deepEqual(
    reminders.map((r) => r.id),
    ["d-good"],
  );
});

test("createReminder publishes a pending 30300 with a fresh 128-bit d tag", async () => {
  const session = fakeSession();
  const crypto = fakeCrypto();
  await createReminder(
    session,
    SELF,
    {
      notBefore: 1_770_000_000,
      note: "check this",
      target: {
        eventId: "e".repeat(64),
        channelId: "chan-1",
        preview: "ship it",
        authorPubkey: "b".repeat(64),
      },
    },
    crypto,
  );

  assert.equal(session.published.length, 1);
  const event = session.published[0];
  assert.equal(event.kind, 30300);
  assert.match(tagValue(event.tags, "d"), /^[0-9a-f]{32}$/);
  assert.equal(tagValue(event.tags, "not_before"), "1770000000");
  const payload = JSON.parse(event.content.slice(MARKER.length));
  assert.equal(payload.status, "pending");
  assert.equal(payload.note, "check this");
  assert.equal(payload.target.channelId, "chan-1");
});

test("createReminder gives two reminders different addresses", async () => {
  const session = fakeSession();
  const crypto = fakeCrypto();
  const input = { notBefore: 1_770_000_000, note: "x" };
  await createReminder(session, SELF, input, crypto);
  await createReminder(session, SELF, input, crypto);
  const [first, second] = session.published;
  assert.notEqual(tagValue(first.tags, "d"), tagValue(second.tags, "d"));
});

test("snoozeReminder replaces the SAME address with a later not_before", async () => {
  const session = fakeSession();
  const reminder = {
    id: "d-keep",
    notBefore: 100,
    createdAt: 10,
    eventId: "e-old",
    content: { status: "pending", note: "later" },
  };
  await snoozeReminder(session, SELF, reminder, 5_000, fakeCrypto());

  const event = session.published[0];
  assert.equal(tagValue(event.tags, "d"), "d-keep");
  assert.equal(tagValue(event.tags, "not_before"), "5000");
  assert.ok(
    event.created_at > reminder.createdAt,
    "a replacement must outrank the head it replaces",
  );
  assert.equal(
    JSON.parse(event.content.slice(MARKER.length)).status,
    "pending",
  );
});

test("completeReminder omits not_before and adds an expiration", async () => {
  const session = fakeSession();
  const reminder = {
    id: "d-done",
    notBefore: 100,
    createdAt: 10,
    eventId: "e-old",
    content: { status: "pending", note: "finish" },
  };
  await completeReminder(session, SELF, reminder, fakeCrypto());

  const event = session.published[0];
  assert.equal(tagValue(event.tags, "d"), "d-done");
  assert.equal(
    event.tags.some((tag) => tag[0] === "not_before"),
    false,
    "a done reminder that keeps not_before goes on firing forever",
  );
  assert.ok(Number(tagValue(event.tags, "expiration")) > event.created_at);
  assert.equal(JSON.parse(event.content.slice(MARKER.length)).status, "done");
});

test("cancelReminder writes the cancelled status, not done", async () => {
  const session = fakeSession();
  await cancelReminder(
    session,
    SELF,
    {
      id: "d-cancel",
      notBefore: 100,
      createdAt: 10,
      eventId: "e-old",
      content: { status: "pending", note: "drop it" },
    },
    fakeCrypto(),
  );
  const event = session.published[0];
  assert.equal(
    JSON.parse(event.content.slice(MARKER.length)).status,
    "cancelled",
  );
  assert.equal(
    event.tags.some((tag) => tag[0] === "not_before"),
    false,
  );
});

test("a rejected publish rejects the call rather than reporting success", async () => {
  const session = fakeSession();
  session.publishResult = {
    ok: false,
    message: "invalid: malformed not_before",
  };
  await assert.rejects(
    () =>
      createReminder(session, SELF, { notBefore: 1, note: "x" }, fakeCrypto()),
    /malformed not_before/,
  );
});

test("a session that cannot seal reports the key problem, not a raw error", async () => {
  const crypto = fakeCrypto({
    encryptToSelf: () => {
      throw new Error("no unlocked secret");
    },
  });
  await assert.rejects(
    () =>
      createReminder(fakeSession(), SELF, { notBefore: 1, note: "x" }, crypto),
    (error) => {
      assert.equal(error.name, "ReminderKeyUnavailableError");
      assert.match(error.message, /unlocked local key/);
      return true;
    },
  );
});
