import assert from "node:assert/strict";
import { after, test } from "node:test";

// The upload BODY TYPE is load-bearing on iOS: CapacitorHttp replaces
// XMLHttpRequest there, and its body converter only base64-encodes File
// bodies. An ArrayBuffer falls through to its JSON branch and the upload dies
// as "Network error while uploading". Browsers accept either, so nothing but
// this test notices a regression back to `bytes.buffer`.

const originals = {
  XMLHttpRequest: globalThis.XMLHttpRequest,
  stubs: globalThis.__BUZZ_TEST_MODULE_STUBS__,
};
globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  "../lib/relay-url":
    'export function relayHttpBaseUrl(){return "https://relay.test";} export function publicAppOrigin(){return "https://relay.test";}',
  "../lib/key-store": "export function getAuthTagJson(){return null;}",
  "../lib/nostr-signer":
    'export async function signNostrEvent(event){return {...event,id:"test",pubkey:"test",sig:"test"};}',
};

const sent = [];
class FakeXHR {
  constructor() {
    this.headers = {};
    this.upload = {};
    this.status = 0;
    this.responseText = "";
  }
  open(method, url) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name, value) {
    this.headers[name] = value;
  }
  abort() {}
  send(body) {
    sent.push({ body, headers: this.headers, url: this.url });
    this.status = 200;
    this.responseText = JSON.stringify({
      url: "https://relay.test/media/x",
      sha256: "x",
      type: this.headers["Content-Type"],
      size: 3,
    });
    queueMicrotask(() => this.onload());
  }
}
globalThis.XMLHttpRequest = FakeXHR;

const { uploadBlob } = await import("./blossom.ts");
after(() => {
  globalThis.XMLHttpRequest = originals.XMLHttpRequest;
  globalThis.__BUZZ_TEST_MODULE_STUBS__ = originals.stubs;
});

test("uploadBlob sends XHR a File body (not an ArrayBuffer) with the uploaded bytes and Content-Type", async () => {
  sent.length = 0;
  const payload = new Uint8Array([7, 1, 255, 0, 42]);
  const descriptor = await uploadBlob(
    new File([payload], "doc.pdf", { type: "application/pdf" }),
  );
  assert.equal(descriptor.mime_type, "application/pdf");
  assert.equal(sent.length, 1);
  const { body, headers } = sent[0];
  assert.equal(headers["Content-Type"], "application/pdf");
  assert.ok(
    !(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body),
    `body must not be raw bytes (got ${Object.prototype.toString.call(body)})`,
  );
  assert.ok(body instanceof File, "body must be a File for CapacitorHttp");
  assert.equal(body.type, "application/pdf");
  assert.deepEqual(new Uint8Array(await body.arrayBuffer()), payload);
});

test("uploadBlob strips MP3 tags before hashing and sends audio/mpeg", async () => {
  sent.length = 0;
  const frames = [];
  for (let i = 0; i < 3; i += 1) {
    frames.push(0xff, 0xfb, 0x90, 0x00);
    for (let j = 0; j < 413; j += 1) frames.push((i + j) % 0x7f);
  }
  const clean = Uint8Array.from(frames);
  const id3 = Array.from("ID3\x04\0\0\0\0\0\x05TIT2x", (c) => c.charCodeAt(0));
  const v1 = Array.from("TAGSecret", (c) => c.charCodeAt(0));
  while (v1.length < 128) v1.push(0x20);
  const tagged = Uint8Array.from([...id3, ...clean, ...v1]);

  // A browser that gives no MIME: the bytes alone must route to the stripper.
  await uploadBlob(new File([tagged], "song.mp3", { type: "" }));
  assert.equal(sent.length, 1);
  const { body, headers } = sent[0];
  assert.equal(headers["Content-Type"], "audio/mpeg");
  const uploaded = new Uint8Array(await body.arrayBuffer());
  assert.deepEqual(uploaded, clean, "only the audio frames are uploaded");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", clean));
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  assert.equal(headers["X-SHA-256"], hex, "hash covers the stripped bytes");
});
