import { finalizeEvent, getPublicKey } from "nostr-tools/pure";

/**
 * Seed a live relay with a channel and a huddle, signing as the same key the
 * browser will sign in with.
 *
 * The huddle surfaces cannot be reached without real relay state: the bar only
 * renders for a ttl channel, and its in-call controls only once the audio room
 * has admitted the viewer. Driving channel creation through the UI would test
 * the New Channel dialog rather than the huddle, so the setup rides the same
 * wire the app does — plain signed events over one authenticated socket.
 *
 * Requires `E2E_RELAY_WS` to point at a running relay; the spec skips itself
 * when it is unset, rather than passing on a browser that reached nothing.
 */

export interface SeededHuddle {
  parentChannelId: string;
  ephemeralChannelId: string;
  pubkey: string;
}

export interface UnsignedTemplate {
  kind: number;
  tags: string[][];
  content: string;
}

/**
 * One authenticated relay socket that publishes events STRICTLY IN ORDER,
 * waiting for each OK before sending the next.
 *
 * Serial, not batched, and that is load-bearing: channel creation completes in
 * a spawned task, so an add-member or link event sent in the same burst as its
 * kind-9007 races the row into existence and comes back
 * `restricted: not a channel member`. Measured, not theorised — a batched
 * version of this helper failed exactly that way.
 */
export async function publishAs(
  relayUrl: string,
  secretKey: Uint8Array,
  templates: UnsignedTemplate[],
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(relayUrl);
    let authed = false;
    let index = 0;
    let awaitingId: string | null = null;
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`relay seed timed out against ${relayUrl}`));
    }, 30_000);

    const settle = (error?: Error) => {
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve();
    };

    const sendNext = () => {
      if (index >= templates.length) {
        settle();
        return;
      }
      const event = finalizeEvent(
        { ...templates[index], created_at: Math.floor(Date.now() / 1000) },
        secretKey,
      );
      index += 1;
      awaitingId = event.id;
      socket.send(JSON.stringify(["EVENT", event]));
    };

    socket.onerror = () => settle(new Error(`relay unreachable: ${relayUrl}`));
    socket.onmessage = (message) => {
      const frame = JSON.parse(String(message.data)) as unknown[];
      if (frame[0] === "AUTH" && typeof frame[1] === "string") {
        socket.send(
          JSON.stringify([
            "AUTH",
            finalizeEvent(
              {
                kind: 22242,
                created_at: Math.floor(Date.now() / 1000),
                tags: [
                  ["relay", relayUrl],
                  ["challenge", frame[1]],
                ],
                content: "",
              },
              secretKey,
            ),
          ]),
        );
        return;
      }
      if (frame[0] !== "OK") return;
      if (!authed) {
        // The first OK is the AUTH acknowledgement; publishing before it is
        // rejected, so the first event waits for it.
        authed = true;
        sendNext();
        return;
      }
      if (String(frame[1]) !== awaitingId) return;
      if (frame[2] !== true) {
        settle(new Error(`relay refused a seed event: ${String(frame[3])}`));
        return;
      }
      sendNext();
    };
  });
}

/**
 * Create a parent channel, a ttl-backed huddle channel, and the kind-48100
 * link between them — the exact three events `startHuddle` produces, plus the
 * parent the web client's own flow assumes already exists.
 */
export async function seedHuddle(
  relayUrl: string,
  secretKey: Uint8Array,
  options: {
    /** Extra pubkeys admitted to the ephemeral channel as ordinary members. */
    extraMembers?: readonly string[];
    /** Pubkeys admitted with role `bot` — huddle agents, for the speech gate. */
    extraBots?: readonly string[];
    /** kind-30177 registry entries to publish, so the agent picker is not empty. */
    registryAgents?: readonly { pubkey: string; name: string }[];
  } = {},
): Promise<SeededHuddle> {
  const parentChannelId = crypto.randomUUID();
  const ephemeralChannelId = crypto.randomUUID();
  await publishAs(relayUrl, secretKey, [
    {
      kind: 9007,
      tags: [
        ["h", parentChannelId],
        ["name", `e2e-${parentChannelId.slice(0, 6)}`],
        // Private, not open: an open channel is visible community-wide, so a
        // shared dev relay accumulates one per run and every later run's
        // shell opens a REQ for all of them. That is not hypothetical — it
        // grew the sidebar to a dozen channels and the extra subscription
        // churn dropped the page's relay socket mid-test.
        ["visibility", "private"],
        ["channel_type", "stream"],
      ],
      content: "",
    },
    {
      kind: 9007,
      tags: [
        ["h", ephemeralChannelId],
        ["name", `huddle-${ephemeralChannelId.slice(0, 4)}`],
        ["visibility", "private"],
        ["channel_type", "stream"],
        ["ttl", "3600"],
      ],
      content: "",
    },
    {
      kind: 48100,
      tags: [["h", parentChannelId]],
      content: JSON.stringify({ ephemeral_channel_id: ephemeralChannelId }),
    },
    // Extra members ride the same batch: the channel creator is the only key
    // that may admit them, and it is the one signing here.
    ...(options.extraMembers ?? []).map((pubkey) => ({
      kind: 9000,
      tags: [
        ["h", ephemeralChannelId],
        ["p", pubkey.toLowerCase()],
      ],
      content: "",
    })),
    ...(options.extraBots ?? []).map((pubkey) => ({
      kind: 9000,
      tags: [
        ["h", ephemeralChannelId],
        ["p", pubkey.toLowerCase()],
        ["role", "bot"],
      ],
      content: "",
    })),
    ...(options.registryAgents ?? []).map((agent) => ({
      kind: 30177,
      tags: [["d", agent.pubkey.toLowerCase()]],
      content: JSON.stringify({
        name: agent.name,
        system_prompt: "e2e",
        model: "e2e-model",
        provider: "e2e",
        respond_to: "owner-only",
      }),
    })),
  ]);
  return {
    parentChannelId,
    ephemeralChannelId,
    pubkey: getPublicKey(secretKey),
  };
}
