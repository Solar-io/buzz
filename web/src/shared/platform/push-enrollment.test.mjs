import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createPushEnrollment } from "./push-enrollment.ts";
import {
  enrollTranscript,
  rotateTranscript,
  transcriptHash,
} from "./push-wire.ts";

const USER = "11".repeat(32),
  RELAY = "22".repeat(32);
const HANDLE = "10000000-0000-4000-8000-000000000001";
const CHALLENGE = "20000000-0000-4000-8000-000000000002";
function fixture() {
  const values = new Map(),
    requests = [],
    published = [],
    encrypted = [],
    attestHashes = [];
  let time = 1800000000000,
    endpoint = "aa".repeat(32),
    accepted = true,
    grant = true,
    profiles = true;
  let installationExpires = 0,
    epoch = 1;
  const plugin = {
    readState: async ({ scope }) => ({ value: values.get(scope) ?? null }),
    writeState: async ({ scope, value }) => {
      if (value === null) values.delete(scope);
      else values.set(scope, value);
    },
    requestAuthorizationAndRegister: async () => ({ granted: grant }),
    apnsToken: async () => ({ token: endpoint }),
    isSupported: async () => ({ supported: true }),
    generateKey: async () => ({ keyId: "test-attest-key" }),
    attest: async (args) => {
      attestHashes.push(args.clientDataHash);
      return { attestation: "signed-attestation" };
    },
    assertKey: async () => ({ assertion: "signed-assertion" }),
  };
  const options = {
    relayUrl: "wss://relay.test",
    gatewayUrl: "https://gateway.test",
    profile: "buzz-capacitor-ios-sandbox",
    pubkey: USER,
    plugin,
    now: () => time,
    encrypt: async (peer, plaintext) => {
      encrypted.push({ peer, plaintext });
      return { ciphertext: `sealed:${plaintext}` };
    },
    publish: async (event) => {
      published.push(event);
      return { ok: accepted, message: accepted ? "" : "lease rejected" };
    },
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      const body = init?.body ? JSON.parse(init.body) : null;
      requests.push({ path, body });
      let result;
      if (path === "/info")
        result = {
          push: {
            origin: "wss://relay.test",
            keys: [{ id: "relay-v1", pubkey: RELAY, current: true }],
            app_profiles: profiles
              ? [{ id: "buzz-capacitor-ios-sandbox", transport: "apns" }]
              : [],
            limitation: { max_lease_ttl: 2592000 },
          },
        };
      else if (path === "/v1/installations/challenges")
        result = {
          challenge_id: CHALLENGE,
          challenge: "challenge-value",
          expires_at: time / 1000 + 300,
        };
      else if (path === "/v1/installations") {
        installationExpires = body.expires_at;
        result = {
          installation_handle: HANDLE,
          endpoint_epoch: epoch,
          expires_at: installationExpires,
        };
      } else if (path === "/v1/delegations")
        result = { endpoint_grant: "opaque-test-grant" };
      else if (path === "/v1/delegations/revoke")
        result = { status: "revoked" };
      else if (path === "/v1/installations/endpoint") {
        assert.equal(body.endpoint_epoch, epoch);
        epoch = body.new_endpoint_epoch;
        result = { status: "rotated" };
      } else if (path === "/v1/installations/renew") {
        assert.equal(body.endpoint_epoch, epoch);
        installationExpires = body.expires_at;
        result = {
          installation_handle: HANDLE,
          endpoint_epoch: epoch,
          expires_at: installationExpires,
        };
      } else throw new Error(`Unexpected request ${path}`);
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
  return {
    options,
    values,
    requests,
    published,
    encrypted,
    attestHashes,
    service: () => createPushEnrollment(options),
    advance: (seconds) => {
      time += seconds * 1000;
    },
    token: (value) => {
      endpoint = value;
    },
    accept: (value) => {
      accepted = value;
    },
    permission: (value) => {
      grant = value;
    },
    profiles: (value) => {
      profiles = value;
    },
    state: () => JSON.parse([...values.values()][0]),
  };
}
test("push transcripts match the gateway field order and exact audience", async () => {
  const c = { challenge_id: CHALLENGE, challenge: "abc", expires_at: 2000 };
  const expected =
    'buzz.push.enroll.v1\n{"v":1,"audience":"https://push.buzz.xyz/v1/installations","challenge_id":"20000000-0000-4000-8000-000000000002","challenge":"abc","key_id":"key","app_profile":"buzz-capacitor-ios-sandbox","endpoint":"aa","endpoint_epoch":1,"expires_at":1900}';
  assert.equal(
    enrollTranscript(c, "key", "buzz-capacitor-ios-sandbox", "aa", 1900),
    expected,
  );
  assert.equal(
    await transcriptHash(expected),
    createHash("sha256").update(expected).digest("base64"),
  );
  assert.equal(
    rotateTranscript(c, HANDLE, 1, "bb"),
    'buzz.push.rotate-endpoint.v1\n{"v":1,"audience":"https://push.buzz.xyz/v1/installations/endpoint","challenge_id":"20000000-0000-4000-8000-000000000002","challenge":"abc","installation_handle":"10000000-0000-4000-8000-000000000001","endpoint_epoch":1,"new_endpoint_epoch":2,"endpoint":"bb"}',
  );
});
test("enable encrypts the lease to the advertised relay key before publishing", async () => {
  const f = fixture();
  assert.equal((await f.service().enable()).enabled, true);
  assert.equal(f.published.length, 1);
  assert.equal(f.encrypted.length, 1);
  assert.equal(f.encrypted[0].peer, RELAY);
  assert.equal(f.published[0].content, `sealed:${f.encrypted[0].plaintext}`);
  assert.equal(f.published[0].kind, 30350);
  const body = JSON.parse(f.encrypted[0].plaintext);
  assert.equal(body.endpoint, "opaque-test-grant");
  assert.equal(body.generation, 1);
  assert.deepEqual(body.subscriptions, [
    { filter: { kinds: [9], "#p": [USER] }, class: "default" },
  ]);
  assert.equal(JSON.stringify(f.published[0]).includes("aa".repeat(32)), false);
  assert.equal(f.published[0].tags.find((t) => t[0] === "d")[1], HANDLE);
});
test("negative relay ack stays pending, retry publishes identical event", async () => {
  const f = fixture();
  const service = f.service();
  f.accept(false);
  await assert.rejects(service.enable(), /lease rejected/);
  assert.equal((await service.status()).enabled, false);
  assert.equal((await service.status()).pending, true);
  const first = structuredClone(f.published[0]);
  f.accept(true);
  await service.maintain();
  assert.deepEqual(f.published[1], first);
  assert.equal((await service.status()).enabled, true);
  assert.equal((await service.status()).pending, false);
});
test("disable supersedes a rejected enable, even after its profile is withdrawn", async () => {
  const f = fixture();
  const service = f.service();
  f.accept(false);
  await assert.rejects(service.enable(), /lease rejected/);
  f.accept(true);
  f.profiles(false);
  const result = await service.disable();
  assert.equal(result.enabled, false);
  assert.equal(f.published.length, 2);
  const body = JSON.parse(f.encrypted.at(-1).plaintext);
  assert.deepEqual(body, {
    v: 1,
    origin: "wss://relay.test",
    generation: 2,
    active: false,
  });
  assert.equal(f.published[1].tags.find((t) => t[0] === "d")[1], HANDLE);
  assert.equal(f.state().desired, false);
  const count = f.requests.length;
  await service.maintain();
  assert.equal(f.requests.length, count);
});
test("token rotation retains the installation and advances endpoint+lease generations", async () => {
  const f = fixture();
  const service = f.service();
  await service.enable();
  f.token("bb".repeat(32));
  await service.maintain();
  assert.equal(
    f.requests.filter((r) => r.path === "/v1/installations").length,
    1,
  );
  const rotate = f.requests.find(
    (r) => r.path === "/v1/installations/endpoint",
  );
  assert.equal(rotate.body.endpoint_epoch, 1);
  assert.equal(rotate.body.new_endpoint_epoch, 2);
  assert.equal(f.state().epoch, 2);
  assert.equal(f.state().generation, 2);
  assert.equal(f.state().handle, HANDLE);
});
test("active installations renew before expiration rather than duplicating the token", async () => {
  const f = fixture();
  const service = f.service();
  await service.enable();
  const previous = f.state().installationExpires;
  f.advance(29 * 86400 + 1);
  await service.maintain();
  assert.equal(
    f.requests.filter((r) => r.path === "/v1/installations/renew").length,
    1,
  );
  assert.equal(
    f.requests.filter((r) => r.path === "/v1/installations").length,
    1,
  );
  assert.ok(f.state().installationExpires > previous);
  assert.equal(f.state().generation, 2);
});
test("concurrent enables serialize generations across service instances", async () => {
  const f = fixture();
  await Promise.all([f.service().enable(), f.service().enable()]);
  assert.equal(
    f.requests.filter((r) => r.path === "/v1/installations").length,
    1,
  );
  assert.deepEqual(
    f.encrypted.map((x) => JSON.parse(x.plaintext).generation),
    [1, 2],
  );
  assert.ok(f.published[1].created_at > f.published[0].created_at);
});
test("denied permission never creates an installation or lease", async () => {
  const f = fixture();
  f.permission(false);
  await assert.rejects(f.service().enable(), /permission/);
  assert.equal(f.requests.length, 1);
  assert.equal(f.values.size, 0);
  assert.equal(f.published.length, 0);
});

test("cold-launch maintenance waits for APNs registration without disabling a valid lease", async () => {
  const f = fixture();
  const service = f.service();
  await service.enable();
  f.options.plugin.apnsToken = async () => ({ token: null });
  const calls = f.requests.length;
  const status = await service.maintain();
  assert.equal(status.enabled, true);
  assert.equal(f.requests.length, calls);
  f.options.plugin.apnsToken = async () => ({ token: "bb".repeat(32) });
  await service.maintain();
  assert.equal(f.state().epoch, 2);
});
test("wrong relay descriptor origin is rejected before requesting native authority", async () => {
  const f = fixture();
  f.options.fetch = async () =>
    new Response(JSON.stringify({ push: { origin: "wss://other.test" } }));
  await assert.rejects(f.service().enable(), /origin/);
  assert.equal(f.values.size, 0);
  assert.equal(f.published.length, 0);
});
test("push endpoints reject credentials and plaintext transport", () => {
  const f = fixture();
  assert.throws(
    () => createPushEnrollment({ ...f.options, relayUrl: "ws://relay.test" }),
    /secure/,
  );
  assert.throws(
    () =>
      createPushEnrollment({
        ...f.options,
        gatewayUrl: "https://user:pass@gateway.test",
      }),
    /secure/,
  );
});
