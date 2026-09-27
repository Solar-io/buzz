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

const {
  clearAgentVoiceAssignment,
  publishAgentVoiceAssignment,
  publishAgentVoiceSelection,
} = await import("./agentVoiceApi.ts");
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

  assert.equal(
    signed[0].content,
    '{"engine":"pocket","key":"pocket:azelma","label":"Azelma","version":1}',
    "30182 content uses the CLI's sorted key order",
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

// ── Owner assignment (kind 30183) ──────────────────────────────────────────

const AGENT_HEX = "b".repeat(64);

function recordingSigner(signed) {
  globalThis.__BUZZ_TEST_SIGNER__ = async (template) => {
    signed.push(template);
    return {
      ...template,
      id: "e".repeat(64),
      pubkey: SELF,
      sig: "s".repeat(128),
    };
  };
}

test("an assignment signs kind 30183 with d = the agent, CLI-identical body", async () => {
  const signed = [];
  recordingSigner(signed);
  const session = fakeSession();
  await publishAgentVoiceAssignment(
    session,
    AGENT_HEX.toUpperCase(),
    { engine: "chatterbox", key: "chatterbox:evie" },
    "Evie",
  );
  assert.equal(signed.length, 1);
  assert.equal(signed[0].kind, 30183);
  assert.deepEqual(signed[0].tags, [["d", AGENT_HEX]], "d lowercased");
  // Byte-identical to the CLI: crates/buzz-cli/src/commands/voices.rs
  // selection_body is a serde_json `json!` (no preserve_order feature), so
  // keys serialize SORTED. The same literal is pinned there by
  // `selection_body_wire_bytes_are_key_sorted`.
  assert.equal(
    signed[0].content,
    '{"engine":"chatterbox","key":"chatterbox:evie","label":"Evie","version":1}',
  );
  assert.equal(session.published.length, 1);
});

test("an assignment refuses a malformed agent pubkey before signing", async () => {
  const signed = [];
  recordingSigner(signed);
  await assert.rejects(
    publishAgentVoiceAssignment(
      fakeSession(),
      "not-hex",
      { engine: "chatterbox", key: "chatterbox:evie" },
      "Evie",
    ),
    /64 hex/,
  );
  assert.equal(signed.length, 0);
});

test("a non-owner refusal surfaces the relay's restricted: message", async () => {
  recordingSigner([]);
  const refusing = {
    async publish() {
      return {
        ok: false,
        message:
          "restricted: agent-voice assignment author must be the registered owner",
      };
    },
  };
  await assert.rejects(
    publishAgentVoiceAssignment(
      refusing,
      AGENT_HEX,
      { engine: "chatterbox", key: "chatterbox:evie" },
      "Evie",
    ),
    /restricted: agent-voice assignment/,
  );
});

test("clearing publishes a kind-5 coordinate delete of 30183:<owner>:<agent>", async () => {
  const signed = [];
  recordingSigner(signed);
  const session = fakeSession();
  const deletion = await clearAgentVoiceAssignment(session, SELF, AGENT_HEX);
  assert.equal(signed[0].kind, 5);
  assert.deepEqual(signed[0].tags, [["a", `30183:${SELF}:${AGENT_HEX}`]]);
  assert.equal(
    deletion.kind,
    5,
    "the signed deletion is returned for local folding",
  );
  assert.equal(session.published.length, 1);
});
