import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";

const calls = [];
let failure = false;
globalThis.__BUZZ_NATIVE_AUTH_TEST__ = {
  async state() { return { pubkey: "a".repeat(64), locked: false }; },
  async enroll({ secretHex }) { calls.push(["enroll", secretHex.length]); return this.state(); },
  async leave() { calls.push("leave"); },
  async revoke() { calls.push("revoke"); if (failure) throw new Error("revocation offline"); },
  async forget() { calls.push("forget"); },
};
globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  "../platform/native.ts": `
    export const isNativeIOS = () => true;
    export const BuzzIdentity = globalThis.__BUZZ_NATIVE_AUTH_TEST__;
    export const BuzzHuddle = globalThis.__BUZZ_NATIVE_AUTH_TEST__;
  `,
  "../platform/native-push-revoke.ts": `export const revokeNativePush = () => globalThis.__BUZZ_NATIVE_AUTH_TEST__.revoke();`,
};
const store = await import("./key-store.ts");
beforeEach(() => { calls.length = 0; failure = false; });

test("native forget revokes before erasing identity even without a mounted auth component", async () => {
  await store.signOut();
  assert.deepEqual(calls, ["leave", "revoke", "forget"]);
  assert.equal(store.getAuthState().status, "anonymous");
});
test("native forget retains signing identity when push revocation fails", async () => {
  await store.initKeyStore();
  failure = true;
  await assert.rejects(store.signOut(), /revocation offline/);
  assert.deepEqual(calls, ["leave", "revoke"]);
  assert.equal(store.getAuthState().status, "unlocked");
});
test("native enrollment hands custody to the plugin without retaining web key bytes", async () => {
  const bytes = new Uint8Array(32).fill(1);
  await store.enrollSecretKey(bytes, "unused-on-native");
  assert.deepEqual(calls, [["enroll", 64]]);
  assert.equal(bytes.every((byte) => byte === 0), true);
  assert.equal(store.getUnlockedSecretKey(), null);
  assert.equal(store.hasUnlockedKey(), true);
});
