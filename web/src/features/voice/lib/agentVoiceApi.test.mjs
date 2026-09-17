import assert from "node:assert/strict";
import { test, after } from "node:test";

// publishAgentVoiceSelection with the SIGNER stubbed at the module seam —
// the fake records the unsigned template it was handed, so the assertions
// pin the wire shape (kind, d tag, JSON body), not a copy of it. The relay
// session is a fake with the same `publish` signature.
globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  "@/shared/lib/nostr-signer": `
    export async function signNostrEvent(template) {
      const handler = globalThis.__BUZZ_TEST_SIGNER__;
      if (!handler) {
        throw new Error("test did not install a signer handler");
      }
      return handler(template);
    }
  `,
};

const { publishAgentVoiceSelection } = await import("./agentVoiceApi.ts");
const { KIND_AGENT_VOICE, AGENT_VOICE_D_TAG } = await import(
  "./agentVoiceSelection.ts"
);

const SELF = "a".repeat(64);

function fakeSession() {
  const published = [];
  return {
    published,
    async publish(event) {
      published.push(event);
      return { ok: true, message: "" };
    },
  };
}

after(() => {
  delete globalThis.__BUZZ_TEST_MODULE_STUBS__;
  delete globalThis.__BUZZ_TEST_SIGNER__;
});

test("publishing a local-synth selection signs kind 30182 at the fixed d tag", async () => {
  const signed = [];
  globalThis.__BUZZ_TEST_SIGNER__ = async (template) => {
    signed.push(template);
    return {
      ...template,
      id: "e".repeat(64),
      pubkey: SELF,
      sig: "s".repeat(128),
    };
  };
  const session = fakeSession();
  await publishAgentVoiceSelection(
    session,
    { engine: "local-synth", voiceURI: "uri:samantha" },
    "Samantha",
  );

  assert.equal(signed.length, 1);
  assert.equal(signed[0].kind, KIND_AGENT_VOICE);
  assert.equal(KIND_AGENT_VOICE, 30182);
  assert.deepEqual(signed[0].tags, [["d", AGENT_VOICE_D_TAG]]);
  const body = JSON.parse(signed[0].content);
  assert.deepEqual(
    body,
    {
      version: 1,
      engine: "local-synth",
      voiceURI: "uri:samantha",
      label: "Samantha",
    },
    "the body must carry exactly the engine-tagged selection plus label",
  );
  assert.equal(session.published.length, 1);
});

test("publishing a pocket selection carries the catalog key, not a voiceURI", async () => {
  const signed = [];
  globalThis.__BUZZ_TEST_SIGNER__ = async (template) => {
    signed.push(template);
    return {
      ...template,
      id: "e".repeat(64),
      pubkey: SELF,
      sig: "s".repeat(128),
    };
  };
  const session = fakeSession();
  await publishAgentVoiceSelection(
    session,
    { engine: "pocket", key: "pocket:azelma" },
    "Azelma",
  );

  const body = JSON.parse(signed[0].content);
  assert.deepEqual(body, {
    version: 1,
    engine: "pocket",
    key: "pocket:azelma",
    label: "Azelma",
  });
  assert.ok(!("voiceURI" in body), "a pocket body must not carry a voiceURI");
  assert.equal(session.published.length, 1);
});

test("a relay refusal throws with the relay's message", async () => {
  globalThis.__BUZZ_TEST_SIGNER__ = async (template) => ({
    ...template,
    id: "e".repeat(64),
    pubkey: SELF,
    sig: "s".repeat(128),
  });
  const refusing = {
    async publish() {
      return {
        ok: false,
        message: "invalid: agent-voice selection requires a string `label`",
      };
    },
  };
  await assert.rejects(
    publishAgentVoiceSelection(
      refusing,
      { engine: "local-synth", voiceURI: "u" },
      "Samantha",
    ),
    /requires a string `label`/,
  );
});
