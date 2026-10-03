import assert from "node:assert/strict";
import test from "node:test";

const PK = "cc".repeat(32);
globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  "@/shared/lib/nostr-signer": `export async function ownPubkey() { return ${JSON.stringify(PK)}; }
    export async function nip44EncryptTo(text) { return {ciphertext:text}; }
    export async function nip44DecryptFrom(text) { return {plaintext:text}; }
    export async function signNostrEvent(event) { return {...event,pubkey:${JSON.stringify(PK)}}; }`,
};
const { sendAdminCommand } = await import("./adminCommandsSend.ts");
const { requestAdminCommand } = await import("./admin/request.ts");

test("sender carries requires, target and fresh issuedAt inside the sealed envelope", async () => {
  let published;
  await sendAdminCommand(
    {
      publish: async (event) => {
        published = event;
        return { ok: true };
      },
    },
    { action: "ping", request: {} },
    { target: "crichton.local", requires: ["ping"] },
  );
  assert.equal(published.kind, 24201);
  const envelope = JSON.parse(published.content);
  assert.deepEqual(envelope.requires, ["ping"]);
  assert.equal(envelope.target, "crichton.local");
  assert.ok(Math.abs(Date.now() - Date.parse(envelope.issuedAt)) < 1000);
});

test("request subscribes before publish, accepts only its owner/request ack, then unsubscribes", async () => {
  let receiver;
  let subscribed = false;
  let closed = 0;
  const session = {
    subscribe(filter, options) {
      subscribed = true;
      assert.deepEqual(filter.authors, [PK]);
      receiver = options.onEvent;
      return () => {
        closed++;
      };
    },
    async publish(event) {
      assert.equal(subscribed, true);
      const command = JSON.parse(event.content);
      const ack = {
        type: "agent_admin_ack",
        requestId: command.requestId,
        ok: true,
        result: { machine: "crichton.local" },
      };
      await receiver({ pubkey: "other", content: JSON.stringify(ack) });
      assert.equal(closed, 0);
      await receiver({
        pubkey: PK,
        content: JSON.stringify({ ...ack, requestId: "other" }),
      });
      assert.equal(closed, 0);
      await receiver({ pubkey: PK, content: JSON.stringify(ack) });
      return { ok: true };
    },
  };
  const result = await requestAdminCommand(
    session,
    { action: "ping", request: {} },
    { target: "crichton.local", requires: ["ping"] },
  );
  assert.equal(result.result.machine, "crichton.local");
  assert.equal(closed, 1);
});

test("request timeout and abort close subscriptions without queueing retries", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let closed = 0;
  let published = 0;
  const session = {
    subscribe: () => () => {
      closed++;
    },
    publish: async () => {
      published++;
      return { ok: true };
    },
  };
  const pending = requestAdminCommand(
    session,
    { action: "ping", request: {} },
    {},
    10_000,
  );
  for (let i = 0; i < 8; i++) await Promise.resolve();
  t.mock.timers.tick(10_000);
  assert.equal(await pending, null);
  assert.equal(closed, 1);
  assert.equal(published, 1);
  const controller = new AbortController();
  const next = requestAdminCommand(
    session,
    { action: "ping", request: {} },
    {},
    10_000,
    controller.signal,
  );
  await Promise.resolve();
  controller.abort();
  assert.equal(await next, null);
  assert.equal(closed, 2);
});
