import assert from "node:assert/strict";
import { after, test } from "node:test";

const originals = {
  fetch: globalThis.fetch,
  stubs: globalThis.__BUZZ_TEST_MODULE_STUBS__,
  sign: globalThis.__BUZZ_TEST_BLOSSOM_SIGN__,
};
const relay =
  'export function relayHttpBaseUrl(){return "https://relay.test";} export function publicAppOrigin(){return "https://relay.test";}';
globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  "../lib/relay-url": relay,
  "./relay-url.ts": relay,
  "../lib/key-store": "export function getAuthTagJson(){return null;}",
  "../lib/nostr-signer":
    'export async function signNostrEvent(event){globalThis.__BUZZ_TEST_BLOSSOM_SIGN__(event);return {...event,id:"test",pubkey:"test",sig:"test"};}',
};
const { fetchSignedBytes, fetchSignedMedia } = await import("./blossom.ts");
after(() => {
  globalThis.fetch = originals.fetch;
  globalThis.__BUZZ_TEST_MODULE_STUBS__ = originals.stubs;
  globalThis.__BUZZ_TEST_BLOSSOM_SIGN__ = originals.sign;
});

test("relative media fetch signs the actual relay host and canonicalizes cache keys", async () => {
  const signed = [],
    requests = [];
  globalThis.__BUZZ_TEST_BLOSSOM_SIGN__ = (event) => signed.push(event);
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-type": "image/png" },
    });
  };
  const first = await fetchSignedMedia("/media/relative-sign.png");
  const second = await fetchSignedMedia(
    "https://relay.test/media/relative-sign.png",
  );
  assert.equal(first, second);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://relay.test/media/relative-sign.png");
  assert.deepEqual(
    signed[0].tags.find((t) => t[0] === "server"),
    ["server", "relay.test"],
  );
  assert.match(requests[0].init.headers.Authorization, /^Nostr /);
  URL.revokeObjectURL(first);
});

test("relative raw-byte media reads normalize the same signed destination", async () => {
  const signed = [],
    requests = [];
  globalThis.__BUZZ_TEST_BLOSSOM_SIGN__ = (event) => signed.push(event);
  globalThis.fetch = async (url) => {
    requests.push(url);
    return new Response(new Uint8Array([9, 8]));
  };
  assert.deepEqual(
    await fetchSignedBytes("/media/raw.bin"),
    new Uint8Array([9, 8]),
  );
  assert.deepEqual(requests, ["https://relay.test/media/raw.bin"]);
  assert.deepEqual(
    signed[0].tags.find((t) => t[0] === "server"),
    ["server", "relay.test"],
  );
});
