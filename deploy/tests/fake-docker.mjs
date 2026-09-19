#!/usr/bin/env node
// State-machine test double. Only reads/writes the explicitly supplied fixture.
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
const path = process.env.CAP_FIXTURE_STATE ?? readFileSync(join(dirname(process.argv[1]), "state-location"), "utf8").trim();
if (!path) throw new Error("Fixture state required; never falls through to Docker.");
const state = JSON.parse(readFileSync(path, "utf8"));
const args = process.argv.slice(2);
const save = () => writeFileSync(path, JSON.stringify(state), { mode: 0o600 });
const find = (name) => state.containers.find((item) => item.Id === name || item.Name === `/${name}`);
const output = (value) => process.stdout.write(`${value}\n`);
const fail = () => { process.stderr.write("fixture operation failed\n"); process.exit(1); };
appendFileSync(`${path}.calls`, JSON.stringify([args[0], args[0] === "rename" ? args.slice(1) : args.at(-1)]) + "\n");
if (args[0] === "inspect") {
  const item = find(args.at(-1)); if (!item) fail();
  if (args[1] !== "--format") output(JSON.stringify([item]));
  else if (args[2] === "{{.Id}}") output(item.Id);
  else if (args[2] === "{{.HostConfig.NetworkMode}}") output(item.HostConfig.NetworkMode);
  else if (args[2].includes(".Mounts")) output(item.Mounts.find((mount) => mount.Destination === "/secrets")?.Source ?? "");
  else if (args[2] === "{{.Image}}") output(item.Image);
  else if (args[2].includes(".Config.Labels")) output(item.Config.Labels[args[2].match(/"([^"]+)"/)[1]]);
  else if (args[2].includes(".Config.Env")) output(item.Config.Env.join("\n"));
  else fail();
} else if (args[0] === "image" && args[1] === "inspect") {
  output(`sha256:${"c".repeat(64)}`);
} else if (args[0] === "create") {
  const current = find("buzz-push-gateway");
  const created = structuredClone(current);
  created.Id = "b".repeat(64); created.Name = `/${args[args.indexOf("--name") + 1]}`; created.Image = args.at(-1);
  created.Config.Env = readFileSync(args[args.indexOf("--env-file") + 1], "utf8").trim().split("\n");
  created.HostConfig.NetworkMode = args[args.indexOf("--network") + 1];
  created.HostConfig.PortBindings = args.flatMap((arg, index) => arg === "-p" ? [args[index + 1]] : []);
  created.State.Running = false; state.containers.push(created); save(); output(created.Id);
} else if (args[0] === "stop") {
  const item = find(args.at(-1)); if (!item) fail(); item.State.Running = false; save(); output(item.Id);
} else if (args[0] === "rename") {
  if (state.failRename && args[1] === "buzz-push-gateway" && args[2].includes(".previous.")) fail();
  const item = find(args[1]); if (!item || find(args[2])) fail(); item.Name = `/${args[2]}`; save();
} else if (args[0] === "start") {
  const item = find(args.at(-1)); if (!item) fail();
  if (state.failStart && item.Id === "b".repeat(64)) fail();
  item.State.Running = true; save(); output(item.Id);
} else if (args[0] === "context" && args[1] === "show") output("fixture");
else if (args.includes("compose")) {
  const files = args.flatMap((arg, index) => arg === "-f" ? [args[index + 1]] : []);
  const overlay = files.find((file) => file.endsWith("compose.capacitor.json"));
  const rollback = files.find((file) => file.endsWith("compose.rollback.private.json"));
  const config = rollback ? JSON.parse(readFileSync(rollback, "utf8")) : structuredClone(state.compose);
  if (overlay) {
    const next = JSON.parse(readFileSync(overlay, "utf8")).services.relay;
    config.services.relay.image = next.image;
    Object.assign(config.services.relay.environment, next.environment);
  }
  if (args.includes("config")) output(JSON.stringify(config));
  else if (args.includes("up")) {
    if (!args.includes("--no-deps") || args.at(-1) !== "relay") fail();
    const item = find("buzz-dev-relay-1"); item.Image = config.services.relay.image;
    item.Id = rollback ? "f".repeat(64) : "9".repeat(64); item.State.Running = true; save();
  } else fail();
} else if (args[0] === "logs") output("fixture container log");
else fail();
