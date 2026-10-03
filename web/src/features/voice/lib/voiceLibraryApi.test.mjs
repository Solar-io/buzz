import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, test } from "node:test";

globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  "../../../shared/lib/relay-url.ts":
    'export function speechServiceUrl() { return "https://bridge.test/tts"; }',
  "./nostr-signer":
    'export async function signNostrEvent(template) { return { ...template, created_at: 1, pubkey: "a".repeat(64), id: "e".repeat(64), sig: "s".repeat(128) }; }',
  "./key-store": 'export function getAuthTagJson() { return "owner-tag"; }',
};
const { addVoice, removeVoice, listLibrary, listAvailable } = await import(
  "./voiceLibraryApi.ts"
);
const { voiceLibraryVersion } = await import("./voiceLibraryRevision.ts");
const originalFetch = globalThis.fetch;
const id = "0123456789abcdef0123456789abcdef";
const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), { status });

test("add signs NIP-98 over the exact body and invalidates mounted libraries", async () => {
  let seen;
  globalThis.fetch = async (url, request) => {
    seen = { url, ...request };
    return reply(
      { voice: { id, label: "Jame" }, voices: [{ id, label: "Jame" }] },
      201,
    );
  };
  const version = voiceLibraryVersion();
  assert.deepEqual(await addVoice("fish", `https://fish.audio/m/${id}`), [
    { id, label: "Jame" },
  ]);
  assert.equal(seen.url, "https://bridge.test/voices/fish");
  assert.equal(seen.method, "POST");
  assert.equal(seen.body, `{"id":"${id}"}`);
  const event = JSON.parse(
    Buffer.from(seen.headers.authorization.slice(6), "base64"),
  );
  assert.equal(event.kind, 27235);
  assert.deepEqual(
    event.tags.find((tag) => tag[0] === "payload"),
    ["payload", createHash("sha256").update(seen.body).digest("hex")],
  );
  assert.deepEqual(
    event.tags.find((tag) => tag[0] === "u"),
    ["u", seen.url],
  );
  assert.deepEqual(
    event.tags.find((tag) => tag[0] === "method"),
    ["method", "POST"],
  );
  assert.ok(event.tags.find((tag) => tag[0] === "nonce")?.[1]);
  assert.equal(seen.headers["x-auth-tag"], "owner-tag");
  assert.equal(seen.headers["content-type"], "application/json");
  assert.equal(voiceLibraryVersion(), version + 1);
});
test("remove signs the exact DELETE URL without a payload and keeps selections intact", async () => {
  let seen;
  globalThis.fetch = async (url, request) => {
    seen = { url, ...request };
    return reply({ removed: true, voices: [] });
  };
  assert.deepEqual(await removeVoice("fish", id), []);
  assert.equal(seen.url, `https://bridge.test/voices/fish/${id}`);
  assert.equal(seen.method, "DELETE");
  assert.equal(seen.body, undefined);
  const event = JSON.parse(
    Buffer.from(seen.headers.authorization.slice(6), "base64"),
  );
  assert.deepEqual(
    event.tags.find((tag) => tag[0] === "method"),
    ["method", "DELETE"],
  );
  assert.deepEqual(
    event.tags.find((tag) => tag[0] === "u"),
    ["u", seen.url],
  );
  assert.equal(
    event.tags.some((tag) => tag[0] === "payload"),
    false,
  );
});
test("available covers own Fish models and encoded length-bounded public search", async () => {
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(url);
    return reply({
      voices: [{ id, label: "Jame", detail: "by author", inLibrary: true }],
    });
  };
  assert.deepEqual(await listAvailable("fish"), [
    { id, label: "Jame", detail: "by author", inLibrary: true },
  ]);
  await listAvailable("fish", "a & b");
  await listAvailable("fish", "x".repeat(100));
  assert.equal(urls[0], "https://bridge.test/voices/fish/available");
  assert.equal(
    urls[1],
    "https://bridge.test/voices/fish/available?q=a%20%26%20b",
  );
  assert.equal(new URL(urls[2]).searchParams.get("q").length, 64);
  assert.equal((await listLibrary("eleven")).length, 1);
});
test("library 403 maps to only the voice-library admin and failed edits never invalidate", async () => {
  const version = voiceLibraryVersion();
  globalThis.fetch = async () => reply({ error: "forbidden" }, 403);
  await assert.rejects(addVoice("fish", id), /Only the voice-library admin/);
  assert.equal(voiceLibraryVersion(), version);
});
test("library errors surface authentication, unknown voice, unusable model and provider failure", async () => {
  for (const [status, message] of [
    [401, /Sign in again/],
    [404, /Voice not found/],
    [422, /not usable/],
    [502, /provider is unavailable/],
    [503, /library is unavailable/],
  ]) {
    globalThis.fetch = async () => reply({ error: "provider detail" }, status);
    await assert.rejects(listLibrary("fish"), message);
  }
});
after(() => {
  globalThis.fetch = originalFetch;
  delete globalThis.__BUZZ_TEST_MODULE_STUBS__;
});
