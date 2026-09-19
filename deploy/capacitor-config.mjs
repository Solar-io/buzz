import { createReadStream, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export function deliveryUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/v1/deliveries/apns") throw new Error("Expected exact HTTPS gateway delivery URL without credentials/query/fragment.");
  return url.href;
}
export function gatewayEnvironment(inspect, mode, delivery, topic) {
  const entries = inspect[0]?.Config?.Env;
  if (!Array.isArray(entries)) throw new Error("Gateway inspection has no environment.");
  const env = Object.fromEntries(entries.map((line) => {
    if (typeof line !== "string" || /[\r\n]/.test(line) || !line.includes("=")) throw new Error("Gateway environment cannot be represented safely as an env file.");
    const split = line.indexOf("="); return [line.slice(0, split), line.slice(split + 1)];
  }));
  for (const name of ["DATABASE_URL", "BUZZ_PUSH_GRANT_KEYS", "BUZZ_PUSH_TOKEN_KEYS", "BUZZ_PUSH_APNS_KEY_ID", "BUZZ_PUSH_APNS_TEAM_ID", "BUZZ_PUSH_APNS_TOPIC", "BUZZ_PUSH_APP_ATTEST_APP_ID", "BUZZ_PUSH_APNS_KEY_PATH", "BUZZ_PUSH_APP_ATTEST_ROOT_CERT_PATH"]) {
    if (!env[name] || /PLACEHOLDER|^undefined$|^null$/i.test(env[name])) throw new Error(`Missing or placeholder gateway setting: ${name}`);
  }
  if (!/^[A-Z0-9]{10}$/.test(env.BUZZ_PUSH_APNS_TEAM_ID) || !/^[A-Z0-9]{10}$/.test(env.BUZZ_PUSH_APNS_KEY_ID)) throw new Error("Provider team/key identifiers must each be ten uppercase alphanumeric characters.");
  const rings = ["BUZZ_PUSH_GRANT_KEYS", "BUZZ_PUSH_TOKEN_KEYS"].map((name) => env[name].split(",").map((entry) => {
    const split = entry.indexOf(":");
    const id = entry.slice(0, split); const encoded = entry.slice(split + 1);
    if (split < 1 || !/^[A-Za-z0-9+/]{43}=$/.test(encoded) || Buffer.from(encoded, "base64").length !== 32) throw new Error(`Invalid gateway keyring: ${name}`);
    return { id, encoded };
  }));
  if (rings[0].some((grant) => rings[1].some((token) => grant.id === token.id || grant.encoded === token.encoded))) throw new Error("Gateway grant/token keyrings must remain independent.");
  if (mode === "native") {
    if (!topic || !/^[A-Za-z0-9.-]+$/.test(topic)) throw new Error("Valid native APNs topic required.");
    const url = deliveryUrl(delivery);
    if (new URL(url).hostname === "push.buzz.xyz") throw new Error("Replacement requires the private deployment delivery URL.");
    env.BUZZ_PUSH_ENABLED_PROFILES = "buzz-capacitor-ios-sandbox,buzz-capacitor-ios-production";
    env.BUZZ_PUSH_CAPACITOR_APNS_TOPIC = topic;
    env.BUZZ_PUSH_CAPACITOR_APP_ATTEST_APP_ID = `${env.BUZZ_PUSH_APNS_TEAM_ID}.${topic}`;
    env.BUZZ_PUSH_PUBLIC_DELIVERY_URL = url;
    env.BUZZ_PUSH_ALLOW_SELF_HOSTED_URL = "true";
  } else if (mode !== "legacy") throw new Error("Unsupported gateway configuration mode.");
  return Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
}
export async function verifyBackup(manifest, ids, read = null, stat = statSync) {
  if (manifest.version !== 1 || manifest.verified !== true || !Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) throw new Error("Verified version-1 backup manifest with artifacts required.");
  for (const [name, id] of Object.entries(ids)) {
    if (!/^[a-f0-9]{64}$/.test(id) || manifest.containers?.[name] !== id) throw new Error(`Backup container identity mismatch: ${name}`);
  }
  for (const artifact of manifest.artifacts) {
    if (typeof artifact.path !== "string" || !artifact.path.startsWith("/") || !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? "")) throw new Error("Backup artifacts need absolute paths and SHA256 hashes.");
    if (!stat(artifact.path).isFile() || stat(artifact.path).size === 0) throw new Error("Backup artifact missing or empty.");
    const hash = createHash("sha256");
    if (read) hash.update(read(artifact.path));
    else for await (const chunk of createReadStream(artifact.path)) hash.update(chunk);
    if (hash.digest("hex") !== artifact.sha256) throw new Error("Backup artifact checksum mismatch.");
  }
}
export function relayEnvironment(before, delivery) {
  const url = deliveryUrl(delivery);
  const lines = before.split(/\r?\n/).filter((line) => !/^(?:export\s+)?BUZZ_PUSH_(?:CAPACITOR_ENABLED|GATEWAY_DELIVERY_URL)=/.test(line));
  return lines.join("\n").replace(/\n*$/, "\n") + `BUZZ_PUSH_CAPACITOR_ENABLED=true\nBUZZ_PUSH_GATEWAY_DELIVERY_URL=${url}\n`;
}
function normalized(value) {
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, normalized(entry)]));
  return value;
}
export function assertRelayOnlyChange(before, after) {
  const left = structuredClone(before.services); const right = structuredClone(after.services);
  if (!left?.relay || !right?.relay) throw new Error("Compose plan does not contain relay.");
  for (const relay of [left.relay, right.relay]) {
    delete relay.image;
    if (relay.environment) { delete relay.environment.BUZZ_PUSH_CAPACITOR_ENABLED; delete relay.environment.BUZZ_PUSH_GATEWAY_DELIVERY_URL; }
  }
  if (JSON.stringify(normalized(left)) !== JSON.stringify(normalized(right))) throw new Error("Compose cutover changed an unrelated service, relay mount, port, credential, or runtime setting.");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, ...args] = process.argv.slice(2);
  const json = (path) => JSON.parse(readFileSync(path, "utf8"));
  try {
    if (mode === "gateway-env") process.stdout.write(gatewayEnvironment(json(args[0]), args[1], args[2], args[3]));
    else if (mode === "verify-backup") await verifyBackup(json(args[0]), Object.fromEntries(args.slice(1).map((entry) => entry.split("="))));
    else if (mode === "relay-env") process.stdout.write(relayEnvironment(readFileSync(args[0], "utf8"), args[1]));
    else if (mode === "check-compose") assertRelayOnlyChange(json(args[0]), json(args[1]));
    else if (mode === "delivery-url") process.stdout.write(deliveryUrl(args[0]));
    else throw new Error("Unknown deployment config operation.");
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
