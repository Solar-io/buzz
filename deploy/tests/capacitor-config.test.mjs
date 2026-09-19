import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { gatewayEnvironment, deliveryUrl, verifyBackup, relayEnvironment, assertRelayOnlyChange } from "../capacitor-config.mjs";

const gateway = () => [{ Config: { Env: [
  "DATABASE_URL=postgres://runtime:fixture-password@postgres/db",
  `BUZZ_PUSH_GRANT_KEYS=grant:${Buffer.alloc(32, 1).toString("base64")}`,
  `BUZZ_PUSH_TOKEN_KEYS=token:${Buffer.alloc(32, 2).toString("base64")}`,
  "BUZZ_PUSH_APNS_KEY_ID=ABCDEFGHIJ", "BUZZ_PUSH_APNS_TEAM_ID=0123456789",
  "BUZZ_PUSH_APNS_TOPIC=cloud.noet.buzz", "BUZZ_PUSH_APP_ATTEST_APP_ID=0123456789.cloud.noet.buzz",
  "BUZZ_PUSH_APNS_KEY_PATH=/secrets/key.p8", "BUZZ_PUSH_APP_ATTEST_ROOT_CERT_PATH=/secrets/AppleAppAttestRootCA.pem",
  "BUZZ_PUSH_ENABLED_PROFILES=buzz-ios-sandbox", "BUZZ_PUSH_PUBLIC_DELIVERY_URL=https://push.buzz.xyz/v1/deliveries/apns",
] } }];
const privateUrl = "https://fixture.tailnet.test:9123/v1/deliveries/apns";
test("native replacement explicitly switches profiles while preserving existing credentials", () => {
  const old = gateway(); const rendered = gatewayEnvironment(old, "native", privateUrl, "cloud.noet.buzz");
  for (const line of old[0].Config.Env.filter((line) => /^(DATABASE_URL|BUZZ_PUSH_(GRANT_KEYS|TOKEN_KEYS|APNS_KEY_ID|APNS_TEAM_ID))=/.test(line))) assert.ok(rendered.split("\n").includes(line));
  assert.match(rendered, /BUZZ_PUSH_ENABLED_PROFILES=buzz-capacitor-ios-sandbox,buzz-capacitor-ios-production\n/);
  assert.match(rendered, /BUZZ_PUSH_CAPACITOR_APP_ATTEST_APP_ID=0123456789.cloud.noet.buzz\n/);
  assert.match(rendered, /BUZZ_PUSH_ALLOW_SELF_HOSTED_URL=true\n/);
  assert.ok(rendered.includes(`BUZZ_PUSH_PUBLIC_DELIVERY_URL=${privateUrl}\n`));
});
test("legacy mode retains current profile and provider settings", () => {
  const old = gateway(); assert.equal(gatewayEnvironment(old, "legacy", "", ""), old[0].Config.Env.join("\n") + "\n");
});
test("gateway refuses placeholder or malformed credentials without including their values in errors", () => {
  for (const line of ["BUZZ_PUSH_APNS_TEAM_ID=PLACEHOLDER", "BUZZ_PUSH_GRANT_KEYS=PRIVATE-CANARY", "BUZZ_PUSH_TOKEN_KEYS=PRIVATE-CANARY\nINJECTED=value"]) {
    const old = gateway(); const key = line.split("=")[0]; old[0].Config.Env = old[0].Config.Env.filter((entry) => !entry.startsWith(key + "=")); old[0].Config.Env.push(line);
    assert.throws(() => gatewayEnvironment(old, "native", privateUrl, "cloud.noet.buzz"), (error) => !error.message.includes("PRIVATE-CANARY"));
  }
});
test("private delivery URL rejects insecure audiences and token-bearing variants", () => {
  for (const url of ["http://host/v1/deliveries/apns", "https://user:secret@host/v1/deliveries/apns", "https://host/v1/deliveries/apns?key=secret", "https://host/other", "https://host/v1/deliveries/apns#fragment"]) assert.throws(() => deliveryUrl(url));
  assert.throws(() => gatewayEnvironment(gateway(), "native", "https://push.buzz.xyz/v1/deliveries/apns", "cloud.noet.buzz"));
});
test("backup verification detects stale identities, changed bytes and empty artifacts", async () => {
  const id = "a".repeat(64); const bytes = Buffer.from("verified fixture dump");
  const manifest = { version: 1, verified: true, containers: { gateway: id }, artifacts: [{ path: "/fixture/dump", sha256: createHash("sha256").update(bytes).digest("hex") }] };
  const stat = () => ({ isFile: () => true, size: bytes.length });
  await verifyBackup(manifest, { gateway: id }, () => bytes, stat);
  await assert.rejects(() => verifyBackup(manifest, { gateway: "b".repeat(64) }, () => bytes, stat));
  await assert.rejects(() => verifyBackup(manifest, { gateway: id }, () => Buffer.from("corrupted"), stat));
  await assert.rejects(() => verifyBackup({ ...manifest, artifacts: [] }, { gateway: id }, () => bytes, stat));
  await assert.rejects(() => verifyBackup(manifest, { gateway: id }, () => bytes, () => ({ isFile: () => true, size: 0 })));
});
test("relay env editing preserves every unrelated line and replaces only native push flags", () => {
  const before = "# keep\nBUZZ_RELAY_PRIVATE_KEY=fixture-secret\nBUZZ_IMAGE=old-relay\nBUZZ_PUSH_CAPACITOR_ENABLED=false\nBUZZ_PUSH_GATEWAY_DELIVERY_URL=https://old/v1/deliveries/apns\n";
  const after = relayEnvironment(before, privateUrl);
  assert.match(after, /BUZZ_RELAY_PRIVATE_KEY=fixture-secret\nBUZZ_IMAGE=old-relay\n/);
  assert.equal(after.match(/BUZZ_PUSH_CAPACITOR_ENABLED=/g).length, 1);
  assert.ok(after.includes("BUZZ_PUSH_CAPACITOR_ENABLED=true\n"));
});
test("compose scope guard permits only relay image/push flags and rejects web mount, pairing, and secret changes", () => {
  const before = { services: { relay: { image: "old", volumes: [{ source: "/live/web", target: "/app/web-dist" }], environment: { DATABASE_URL: "unchanged", BUZZ_PUSH_CAPACITOR_ENABLED: "false" } }, "pairing-relay": { image: "old" }, postgres: { image: "postgres" } } };
  const after = structuredClone(before); after.services.relay.image = "new"; after.services.relay.environment.BUZZ_PUSH_CAPACITOR_ENABLED = "true";
  assertRelayOnlyChange(before, after);
  for (const mutate of [(next) => next.services.relay.volumes[0].source = "/wrong", (next) => next.services["pairing-relay"].image = "new", (next) => next.services.relay.environment.DATABASE_URL = "other"]) {
    const wrong = structuredClone(after); mutate(wrong); assert.throws(() => assertRelayOnlyChange(before, wrong));
  }
});
