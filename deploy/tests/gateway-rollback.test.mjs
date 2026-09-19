import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
const root = fileURLToPath(new URL("../../", import.meta.url));

function fixture(options = {}) {
  const dir = mkdtempSync(join(root, "logs", "deploy-fixture-"));
  const bin = join(dir, "bin"); const secrets = join(dir, "secrets"); mkdirSync(bin); mkdirSync(secrets);
  symlinkSync(resolve(root, "deploy/tests/fake-docker.mjs"), join(bin, "docker"));
  symlinkSync(resolve(root, "deploy/tests/fake-curl.mjs"), join(bin, "curl"));
  writeFileSync(join(bin, "git"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  writeFileSync(join(secrets, "key.p8"), "fixture-key-not-real");
  writeFileSync(join(secrets, "AppleAppAttestRootCA.pem"), "fixture-cert-not-real");
  const old = { Id: "a".repeat(64), Name: "/buzz-push-gateway", Image: `sha256:${"d".repeat(64)}`, State: { Running: true }, Mounts: [{ Source: secrets, Destination: "/secrets" }], HostConfig: { NetworkMode: "fixture-network" }, Config: { Env: [
    "DATABASE_URL=postgres://runtime:PRIVATE-CANARY@postgres/db", `BUZZ_PUSH_GRANT_KEYS=grant:${Buffer.alloc(32, 1).toString("base64")}`, `BUZZ_PUSH_TOKEN_KEYS=token:${Buffer.alloc(32, 2).toString("base64")}`, "BUZZ_PUSH_APNS_KEY_ID=ABCDEFGHIJ", "BUZZ_PUSH_APNS_TEAM_ID=0123456789", "BUZZ_PUSH_APNS_TOPIC=cloud.noet.buzz", "BUZZ_PUSH_APP_ATTEST_APP_ID=0123456789.cloud.noet.buzz", "BUZZ_PUSH_APNS_KEY_PATH=/secrets/key.p8", "BUZZ_PUSH_APP_ATTEST_ROOT_CERT_PATH=/secrets/AppleAppAttestRootCA.pem", "BUZZ_PUSH_ENABLED_PROFILES=buzz-ios-sandbox", "BUZZ_PUSH_PUBLIC_DELIVERY_URL=https://push.buzz.xyz/v1/deliveries/apns",
  ] } };
  const stateFile = join(dir, "state.json");
  writeFileSync(join(bin, "state-location"), stateFile);
  const composeFile = join(dir, "compose.yml"); writeFileSync(composeFile, "services: {}\n");
  const envFile = join(dir, ".env"); writeFileSync(envFile, "BUZZ_IMAGE=fixture-old\nDATABASE_URL=fixture-unchanged\n");
  const relay = { ...old, Id: "f".repeat(64), Name: "/buzz-dev-relay-1", Config: { Env: ["BUZZ_PUSH_GATEWAY_DELIVERY_URL=https://fixture.tailnet.test/v1/deliveries/apns"], Labels: { "com.docker.compose.project": "fixture", "com.docker.compose.project.working_dir": dir, "com.docker.compose.project.environment_file": envFile, "com.docker.compose.project.config_files": composeFile } } };
  const compose = { services: { relay: { image: old.Image, environment: { DATABASE_URL: "fixture-unchanged" }, volumes: [{ source: "/fixture/web", target: "/app/web-dist" }] }, "pairing-relay": { image: old.Image } } };
  writeFileSync(stateFile, JSON.stringify({ containers: [old, { ...old, Id: "e".repeat(64), Name: "/buzz-dev-postgres-1" }, ...(options.integrated ? [relay] : [])], compose, ...options }));
  const backup = join(dir, "dump"); writeFileSync(backup, "verified fixture db dump");
  const manifest = join(dir, "backup.json"); writeFileSync(manifest, JSON.stringify({ version: 1, verified: true, containers: { gateway: old.Id, relay: relay.Id }, artifacts: [{ path: backup, sha256: createHash("sha256").update(readFileSync(backup)).digest("hex") }] }));
  const registry = join(dir, "ports.json"); writeFileSync(registry, JSON.stringify({ project_port_blocks: { buzz: { primary: 61350, push_gateway: 61359, push_gateway_metrics: 61362 } } }));
  return { dir, stateFile, run(extra = []) {
    const command = options.integrated ? [resolve(root, "deploy/deploy-capacitor.sh"), "--replace-native", "--gateway-image", "fixture-image", "--relay-image", "fixture-relay", "--backup-manifest", manifest, "--execute"] : [resolve(root, "deploy/push-gateway-up.sh"), "--replace-native", "--image", "fixture-image", "--delivery-url", "https://fixture.tailnet.test/v1/deliveries/apns", "--backup-manifest", manifest, "--state-dir", join(dir, "deployment"), "--execute"];
    return spawnSync("bash", [...command, ...extra], { cwd: root, encoding: "utf8", timeout: 15000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CAP_FIXTURE_STATE: stateFile, PORT_REGISTRY: registry, CAP_DEPLOY_LOG: join(dir, "verification.log"), CAP_DEPLOY_STATE_ROOT: join(dir, "states"), CAP_HEALTH_RETRIES: "1", CAP_HEALTH_DELAY: "0" } });
  }, state() { return JSON.parse(readFileSync(stateFile, "utf8")); }, cleanup() { rmSync(dir, { recursive: true, force: true }); } };
}

test("healthy gateway cutover retains previous stopped container and never exposes env credentials", () => {
  const f = fixture(); try {
    const result = f.run(); assert.equal(result.status, 0, result.stderr);
    const state = f.state(); assert.equal(state.containers.find((item) => item.Name === "/buzz-push-gateway").Id, "b".repeat(64));
    const old = state.containers.find((item) => item.Id === "a".repeat(64)); assert.match(old.Name, /\.previous\./); assert.equal(old.State.Running, false);
    assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE-CANARY/);
  } finally { f.cleanup(); }
});
for (const fault of ["failReadiness", "failStart", "failRename"]) {
  test(`gateway ${fault} restores the original running container automatically`, () => {
    const f = fixture({ [fault]: true }); try {
      const result = f.run(); assert.notEqual(result.status, 0);
      const old = f.state().containers.find((item) => item.Name === "/buzz-push-gateway");
      assert.equal(old.Id, "a".repeat(64), result.stderr); assert.equal(old.State.Running, true, result.stderr);
      assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE-CANARY/);
    } finally { f.cleanup(); }
  });
}
test("dry-run makes only read-only Docker calls", () => {
  const f = fixture(); try {
    const result = f.run(["--dry-run"]); assert.equal(result.status, 0, result.stderr);
    const calls = readFileSync(`${f.stateFile}.calls`, "utf8").trim().split("\n").map(JSON.parse);
    assert.ok(calls.length > 0); assert.ok(calls.every(([verb]) => verb === "inspect"));
    assert.equal(f.state().containers.length, 2);
  } finally { f.cleanup(); }
});
test("integrated relay failure rolls relay configuration and gateway container back", () => {
  const f = fixture({ integrated: true, failRelayReadiness: true }); try {
    const result = f.run(); assert.notEqual(result.status, 0);
    const state = f.state();
    assert.equal(state.containers.find((item) => item.Name === "/buzz-push-gateway").Id, "a".repeat(64), result.stderr);
    assert.equal(state.containers.find((item) => item.Name === "/buzz-dev-relay-1").Image, `sha256:${"d".repeat(64)}`, result.stderr);
    assert.equal(readFileSync(join(f.dir, ".env"), "utf8"), "BUZZ_IMAGE=fixture-old\nDATABASE_URL=fixture-unchanged\n");
    const calls = readFileSync(`${f.stateFile}.calls`, "utf8"); assert.ok(calls.includes("--context"), result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE-CANARY/);
  } finally { f.cleanup(); }
});
test("integrated healthy cutover scopes service changes to relay and leaves saved gateway available", () => {
  const f = fixture({ integrated: true }); try {
    const result = f.run(); assert.equal(result.status, 0, result.stderr);
    const state = f.state(); assert.equal(state.containers.find((item) => item.Name === "/buzz-dev-relay-1").Image, `sha256:${"c".repeat(64)}`);
    assert.equal(state.containers.find((item) => item.Id === "a".repeat(64)).State.Running, false);
    assert.match(readFileSync(join(f.dir, ".env"), "utf8"), /BUZZ_PUSH_CAPACITOR_ENABLED=true/);
  } finally { f.cleanup(); }
});
