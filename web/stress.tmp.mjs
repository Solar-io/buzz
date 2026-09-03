// Bounded stress probe: can a burst fleet-wide exhaust the GLOBAL handler
// semaphore and produce CLOSED "rate-limited: too many concurrent requests"?
// 3 connections x 30 concurrent heavy REQs, one shot, then report.
import { finalizeEvent } from "nostr-tools";
import { decode } from "nostr-tools/nip19";

const RELAY = process.env.BUZZ_RELAY_URL;
const sk = decode(process.env.BUZZ_PRIVATE_KEY).data;
const AUTH_TAG = JSON.parse(process.env.BUZZ_AUTH_TAG);

const CONNS = 3;
const REQS_PER_CONN = 30;

const CHAN = "0c948745-2c8f-4b04-a31d-17411bd9b42f"; // this DM (readable by me)
let rateLimited = 0;
let eosed = 0;
let closedOther = 0;
let events = 0;
const done = new Promise((resolve) => {
  const finish = setTimeout(resolve, 20000);
  process.on("exit", () => clearTimeout(finish));
});

const openConn = (idx) =>
  new Promise((resolveConn) => {
    const ws = new WebSocket(RELAY);
    ws.addEventListener("message", (msg) => {
      const frame = JSON.parse(msg.data);
      if (frame[0] === "AUTH") {
        const auth = finalizeEvent(
          {
            kind: 22242,
            created_at: Math.floor(Date.now() / 1000),
            tags: [["relay", RELAY], ["challenge", frame[1]], AUTH_TAG],
            content: "stress probe",
          },
          sk,
        );
        ws.send(JSON.stringify(["AUTH", auth]));
        setTimeout(() => {
          for (let i = 0; i < REQS_PER_CONN; i++) {
            ws.send(
              JSON.stringify([
                "REQ",
                `stress-${idx}-${i}`,
                { kinds: [9], "#h": [CHAN], limit: 200 },
              ]),
            );
          }
          resolveConn();
        }, 150 * (idx + 1));
      } else if (frame[0] === "EOSE") {
        eosed++;
      } else if (frame[0] === "CLOSED") {
        if (String(frame[2]).includes("rate-limited")) rateLimited++;
        else closedOther++;
      } else if (frame[0] === "EVENT") {
        events++;
      }
    });
  });

await Promise.all(Array.from({ length: CONNS }, (_, i) => openConn(i)));
await done;
console.log(
  `REQs=${CONNS * REQS_PER_CONN} eose=${eosed} rateLimitedCLOSED=${rateLimited} otherClosed=${closedOther} events=${events}`,
);
process.exit(0);
