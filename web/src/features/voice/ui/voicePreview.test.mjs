import assert from "node:assert/strict";
import { test } from "node:test";
import { createVoicePreviewer } from "./voicePreview.ts";

test("Fish preview posts its own engine and bare model id and schedules bridge PCM", async () => {
  const requests = [];
  let scheduled = 0;
  const context = {
    currentTime: 0,
    destination: {},
    createBuffer: (_channels, length) => ({ length, copyToChannel() {} }),
    createBufferSource: () => ({
      connect() {},
      start() {
        scheduled += 1;
      },
      stop() {},
      buffer: null,
    }),
    resume: async () => {},
    close: async () => {},
  };
  const preview = createVoicePreviewer({
    hostname: () => "bridge.test",
    createContext: () => context,
    fetchImpl: async (url, request) => {
      requests.push([url, JSON.parse(request.body)]);
      return new Response(new Uint8Array(4800));
    },
  });
  preview.preview({
    engine: "fish",
    key: "fish:0123456789abcdef0123456789abcdef",
  });
  for (let i = 0; i < 20 && scheduled === 0; i += 1)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(requests, [
    [
      "https://bridge.test:6366/tts",
      {
        engine: "fish",
        voice: "0123456789abcdef0123456789abcdef",
        text: "Hi, this is my agent voice.",
      },
    ],
  ]);
  assert.ok(scheduled > 0, "PCM reaches the actual bridge player");
  preview.dispose();
});
