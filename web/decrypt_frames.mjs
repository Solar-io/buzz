import * as nip44 from "nostr-tools/nip44";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const envKey = process.env.BUZZ_PRIVATE_KEY.trim();
const mod = await import("nostr-tools");
const decoded = mod.nip19.decode(envKey);
// bytes -> hex
const hex = Buffer.from(decoded.data).toString("hex");
const samPub = "25f1ade509ed6cdbc5cf9856fb4f12bec4d056d19a54143eabec36db9fd2c33c";
const secKey = Uint8Array.from(Buffer.from(hex, "hex"));
const convKey = nip44.v2.utils.getConversationKey(secKey, samPub);

const lines = readFileSync("/tmp/frames_dump.txt", "utf8").trim().split("\n");
const kinds = [];
for (const line of lines) {
  const [ts, ct] = line.split("|");
  try {
    const pt = nip44.v2.decrypt(ct.trim(), convKey);
    const obj = JSON.parse(pt);
    kinds.push(`${ts.slice(11, 19)} ${obj.kind ?? "?"} ch=${obj.channelId?.slice(0, 8) ?? "-"}`);
  } catch {
    kinds.push(`${ts.slice(11, 19)} <decrypt-fail>`);
  }
}
// Print the last 30 and a histogram of kinds around 21:49-22:13
console.log("total:", kinds.length);
console.log("--- around the 21:49 reply and after ---");
for (const k of kinds) {
  const t = k.slice(0, 8);
  if (t >= "21:48:00" && t <= "22:14:00") console.log(k);
}
