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

test("T3: validateServices rejects hostile/malformed URLs (table-driven)", () => {
  const baseValid = {
    relayUrl: "wss://relay.test",
    sttUrl: "wss://stt.test/stt",
    ttsUrl: "https://tts.test/tts",
    pushGatewayUrl: "https://push.test/",
  };

  const hostileCases = [
    // HTTP/unencrypted
    { relayUrl: "http://relay.test" },
    { sttUrl: "ws://relay.test/stt" },
    // Credentials
    { relayUrl: "wss://user:pass@relay.test" },
    // Query and fragment
    { relayUrl: "wss://relay.test/?token=x" },
    { relayUrl: "wss://relay.test#x" },
    // Path on relay (should be denied)
    { relayUrl: "wss://relay.test/socket" },
    // Path on push gateway (should be denied)
    { pushGatewayUrl: "https://push.test/a?b=c" },
    // JavaScript protocol (will throw because URL parsing fails)
    { relayUrl: "javascript:alert(1)" },
    // File protocol (will throw because URL parsing fails)
    { relayUrl: "file:///tmp/x" },
    // Credentials via @ in URL
    { sttUrl: "wss://user@stt.test/stt" },
  ];

  for (const override of hostileCases) {
    const input = { ...baseValid, ...override };
    assert.throws(
      () => validateServices(input),
      `Expected rejection for ${JSON.stringify(override)}`,
    );
  }
});

test("T3b: validateServices rejects URLs with @ character", () => {
  const baseValid = {
    relayUrl: "wss://relay.test",
    sttUrl: "wss://stt.test/stt",
    ttsUrl: "https://tts.test/tts",
    pushGatewayUrl: "https://push.test/",
  };

  // Test @ anywhere in the URL string
  assert.throws(() =>
    validateServices({
      ...baseValid,
      relayUrl: "wss://user@host.test",
    }),
  );
});

test("T3c: validateServices caps each value at 512 characters", () => {
  const baseValid = {
    relayUrl: "wss://relay.test",
    sttUrl: "wss://stt.test/stt",
    ttsUrl: "https://tts.test/tts",
    pushGatewayUrl: "https://push.test/",
  };

  // Create a URL-like string that's definitely over 512 chars
  const longUrl = `wss://${"x".repeat(510)}.test`;
  assert(
    longUrl.length > 512,
    `URL should exceed 512 chars, got ${longUrl.length}`,
  );

  assert.throws(
    () =>
      validateServices({
        ...baseValid,
        relayUrl: longUrl,
      }),
    "should reject URL exceeding 512 chars",
  );
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
