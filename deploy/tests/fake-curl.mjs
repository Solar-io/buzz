#!/usr/bin/env node
import { readFileSync } from "node:fs";
if (!process.env.CAP_FIXTURE_STATE) throw new Error("Fixture state required.");
const state = JSON.parse(readFileSync(process.env.CAP_FIXTURE_STATE, "utf8"));
const current = state.containers.find((item) => item.Name === "/buzz-push-gateway");
process.stdout.write(state.failReadiness && current?.Id === "b".repeat(64) ? "503" : "200");
