import assert from "node:assert/strict";
import { test } from "node:test";
import {
  validateServices,
  writeNativeServices,
  readNativeServices,
} from "./config.ts";

const valid = {
  relayUrl: "wss://relay.test/",
  sttUrl: "wss://voice.test/stt",
  ttsUrl: "https://voice.test/tts",
  pushGatewayUrl: "https://push.test/",
};
test("native service configuration refuses insecure and credential-bearing endpoints", () => {
  for (const relayUrl of [
    "ws://relay.test",
    "https://relay.test",
    "wss://user:secret@relay.test",
    "wss://relay.test/?token=secret",
    "wss://relay.test/#key",
  ]) {
    assert.throws(() => validateServices({ ...valid, relayUrl }));
  }
  assert.throws(() =>
    validateServices({ ...valid, sttUrl: "http://voice.test/stt" }),
  );
  assert.throws(() =>
    validateServices({ ...valid, ttsUrl: "http://voice.test/tts" }),
  );
  assert.deepEqual(validateServices(valid), valid);
});
test("native connection persists the configured relay instead of the bundled origin", () => {
  const prior = globalThis.localStorage;
  let stored = null;
  globalThis.localStorage = {
    getItem: () => stored,
    setItem: (_key, value) => {
      stored = value;
    },
  };
  try {
    writeNativeServices(valid);
    assert.equal(readNativeServices().relayUrl, "wss://relay.test/");
    stored = JSON.stringify({ ...valid, relayUrl: "http://localhost" });
    assert.equal(readNativeServices(), null);
  } finally {
    globalThis.localStorage = prior;
  }
});
