#!/usr/bin/env node
import { readFileSync } from "node:fs";
if (!process.env.CAP_FIXTURE_STATE) throw new Error("Fixture state required.");
const state = JSON.parse(readFileSync(process.env.CAP_FIXTURE_STATE, "utf8"));
const current = state.containers.find((item) => item.Name === "/buzz-push-gateway");
const url = process.argv.at(-1);
if (url.includes(":61350/")) {
  const relay = state.containers.find((item) => item.Name === "/buzz-dev-relay-1");
  process.stdout.write(state.failRelayReadiness && relay.Image === `sha256:${"c".repeat(64)}` ? "503" : "200");
} else process.stdout.write(state.failReadiness && current?.Id === "b".repeat(64) ? "503" : "200");
