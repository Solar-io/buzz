import type { Page } from "@playwright/test";
import * as nip44 from "nostr-tools/nip44";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";

import { hexId, type MockEvent, mockEvent } from "./mockRelay";

/**
 * A workspace for the redesign's Work rail, faked at the relay boundary.
 *
 * The Work tab joins seven event families (asks, mentions, approvals,
 * reminders, observer frames, reactions, turn metrics), three of which are
 * NIP-44 ciphertext — so a fixture built from `mockEvent` alone would prove
 * only that an empty rail renders. The encrypted families are produced here
 * with real keys: reminders self-encrypted by the viewer, observer frames and
 * turn metrics encrypted agent → owner, exactly as the harness does. If the
 * client's decrypt path breaks, these rows vanish and the spec fails.
 */

export interface Agent {
  name: string;
  secretKey: Uint8Array;
  pubkey: string;
}

export interface WorkFixture {
  viewerKey: Uint8Array;
  viewer: string;
  agents: Record<string, Agent>;
  channels: Record<string, string>;
  events: MockEvent[];
}

const CHANNEL_IDS: Record<string, string> = {
  announcements: "10000000-0000-4000-8000-000000000001",
  design: "10000000-0000-4000-8000-000000000002",
  engineering: "10000000-0000-4000-8000-000000000003",
  "flight-path": "10000000-0000-4000-8000-000000000004",
  mobile: "10000000-0000-4000-8000-000000000005",
  ops: "10000000-0000-4000-8000-000000000006",
  "dm-gilfoyle": "20000000-0000-4000-8000-000000000001",
  "dm-nikon": "20000000-0000-4000-8000-000000000002",
  "dm-esp32": "20000000-0000-4000-8000-000000000003",
};

const RELAY = "ee".repeat(32);

function agent(name: string): Agent {
  const secretKey = generateSecretKey();
  return { name, secretKey, pubkey: getPublicKey(secretKey) };
}

function sealed(from: Uint8Array, to: string, payload: unknown): string {
  return nip44.v2.encrypt(
    JSON.stringify(payload),
    nip44.v2.utils.getConversationKey(from, to),
  );
}

export function buildWorkFixture(
  options: {
    /** Seed one more reminder that comes due this many seconds from now. */
    dueInS?: number;
    /**
     * Phase 2's readable-message and ask surfaces: callouts, a file tile
     * group, a /handoff with its receipt, a yes/no ask in the Gilfoyle DM
     * and a three-question card in the ESP32 DM. Off by default, because
     * the asks and receipts move the Work rail's counts the Phase 1 cases
     * pin.
     */
    phase2?: boolean;
  } = {},
  nowS = Math.floor(Date.now() / 1000),
): WorkFixture {
  const viewerKey = generateSecretKey();
  const viewer = getPublicKey(viewerKey);
  const agents = {
    gilfoyle: agent("Gilfoyle"),
    nikon: agent("Lord Nikon"),
    acid: agent("Acid Burn"),
    cereal: agent("Cereal Killer"),
    crash: agent("Crash Override"),
    jared: agent("Jared Dunn"),
    esp32: agent("ESP32"),
  };
  const c = CHANNEL_IDS;
  let seq = 1;
  const id = () => hexId(seq++, "0");
  const events: MockEvent[] = [];
  const push = (event: Partial<MockEvent>) => {
    const built = mockEvent({ id: id(), ...event });
    events.push(built);
    return built;
  };

  // ---- channels, DMs, profiles, the agent registry --------------------------
  const stream = (key: string, about: string) =>
    push({
      kind: 39000,
      created_at: nowS - 86_400,
      tags: [
        ["d", c[key]],
        ["name", key],
        ["about", about],
        ["t", "stream"],
      ],
    });
  stream("announcements", "Company-wide notes");
  stream("design", "Design reviews");
  stream("engineering", "Build, test, ship");
  stream(
    "flight-path",
    "Product · capture plan for the desktop-to-mobile handoff",
  );
  stream("mobile", "iOS and TestFlight");
  stream("ops", "Backups and workflows");
  const dm = (key: string, peer: Agent) =>
    push({
      kind: 39000,
      created_at: nowS - 86_400,
      tags: [
        ["d", c[key]],
        ["name", peer.name],
        ["t", "dm"],
        ["p", viewer],
        ["p", peer.pubkey],
      ],
    });
  dm("dm-gilfoyle", agents.gilfoyle);
  dm("dm-nikon", agents.nikon);
  dm("dm-esp32", agents.esp32);
  push({
    kind: 0,
    pubkey: viewer,
    created_at: nowS - 86_400,
    content: JSON.stringify({ display_name: "Sam" }),
  });
  for (const entry of Object.values(agents)) {
    push({
      kind: 0,
      pubkey: entry.pubkey,
      created_at: nowS - 86_400,
      content: JSON.stringify({ display_name: entry.name }),
    });
    push({
      kind: 30177,
      pubkey: viewer,
      created_at: nowS - 86_400,
      tags: [["d", entry.pubkey]],
      content: JSON.stringify({
        name: entry.name,
        system_prompt: "e2e",
        model: "e2e-model",
        provider: "e2e",
        respond_to: "owner-only",
      }),
    });
  }

  // ---- #flight-path: the conversation on screen -----------------------------
  const flight = c["flight-path"];
  const ask = push({
    kind: 9,
    pubkey: viewer,
    created_at: nowS - 400,
    tags: [
      ["h", flight],
      ["p", agents.gilfoyle.pubkey],
    ],
    content:
      "@Gilfoyle turn the handoff notes into a three-beat capture plan and hand it off.",
  });
  push({
    kind: 9,
    pubkey: agents.gilfoyle.pubkey,
    created_at: nowS - 340,
    tags: [["h", flight]],
    content:
      "Three beats. Beat 01 is already captured.\n\n" +
      "| Beat | What | State |\n|---|---|---|\n" +
      "| 01 | Desktop compose | Captured |\n" +
      "| 02 | Project header settle | Lord Nikon · now |\n" +
      "| 03 | Mobile handoff / sent | Queued |\n\n" +
      "Handoff → **Lord Nikon**: final capture pass.",
  });
  // Three replies under the viewer's ask, so it has a thread to open (the
  // timeline offers "View all N replies" past two).
  for (const [who, text, ago] of [
    [agents.gilfoyle, "On it — splitting the notes into beats now.", 380],
    [agents.nikon, "I can take the capture pass once the beats land.", 360],
    [agents.gilfoyle, "Beat 01 is captured. Two to go.", 350],
  ] as const) {
    push({
      kind: 9,
      pubkey: who.pubkey,
      created_at: nowS - ago,
      tags: [
        ["h", flight],
        ["e", ask.id, "", "root"],
        ["e", ask.id, "", "reply"],
      ],
      content: text,
    });
  }
  const beat3 = push({
    kind: 9,
    pubkey: viewer,
    created_at: nowS - 200,
    tags: [
      ["h", flight],
      ["p", agents.nikon.pubkey],
    ],
    content: "@Lord Nikon beat 02 feels right. Keep the cursor move slow.",
  });
  // An ASK: a decision card p-tagging the viewer.
  push({
    kind: 9,
    pubkey: agents.nikon.pubkey,
    created_at: nowS - 20,
    tags: [
      ["h", flight],
      ["p", viewer],
      [
        "card",
        JSON.stringify({
          v: 1,
          title: "Beat 03 hold: 1.5s or keep 2s?",
          body: "Header settle is in. Trim the sent-message hold, or keep it?",
          options: [
            { label: "Trim to 1.5s", recommended: true },
            { label: "Keep 2s" },
          ],
        }),
      ],
    ],
    content:
      "**Beat 03 hold: 1.5s or keep 2s?**\n\n- Trim to 1.5s *(Recommended)*\n- Keep 2s",
  });

  // A second ask, in the Gilfoyle DM.
  push({
    kind: 9,
    pubkey: agents.gilfoyle.pubkey,
    created_at: nowS - 38 * 60,
    tags: [
      ["h", c["dm-gilfoyle"]],
      ["p", viewer],
      [
        "card",
        JSON.stringify({
          v: 1,
          title: "Run Sol max on 1–2 more builds before 10/8?",
          options: [{ label: "Yes" }, { label: "No" }],
        }),
      ],
    ],
    content: "**Run Sol max on 1–2 more builds before 10/8?**\n\n- Yes\n- No",
  });

  // A MENTION in #engineering (no card).
  const qa = push({
    kind: 9,
    pubkey: agents.acid.pubkey,
    created_at: nowS - 9 * 60,
    tags: [
      ["h", c.engineering],
      ["p", viewer],
    ],
    content:
      "@Sam jitter buffer QA is green — 212 passed, 0 failed. Want the report in #design too?",
  });

  // ---- approvals (relay-signed 46010) ---------------------------------------
  push({
    kind: 46010,
    pubkey: RELAY,
    created_at: nowS - 6 * 60,
    tags: [
      ["d", "wf-merge"],
      ["h", c.engineering],
      ["run", "run-1"],
      ["step", "merge"],
      ["approval", "a1".repeat(32)],
      ["p", viewer],
    ],
    content: "Merge fix(web): clamp jitter calibration",
  });
  push({
    kind: 46010,
    pubkey: RELAY,
    created_at: nowS - 3_600,
    tags: [
      ["d", "wf-backup"],
      ["h", c.ops],
      ["run", "run-2"],
      ["step", "prune"],
      ["approval", "b2".repeat(32)],
      ["p", viewer],
    ],
    content: "nightly-backup: approve the prune step",
  });
  // A granted approval must NOT appear.
  push({
    kind: 46010,
    pubkey: RELAY,
    created_at: nowS - 7_200,
    tags: [
      ["d", "wf-old"],
      ["h", c.ops],
      ["run", "run-3"],
      ["approval", "c3".repeat(32)],
      ["p", viewer],
    ],
    content: "already decided — must not be listed",
  });
  push({
    kind: 46011,
    pubkey: RELAY,
    created_at: nowS - 7_100,
    tags: [
      ["d", "wf-old"],
      ["h", c.ops],
      ["run", "run-3"],
      ["approval", "c3".repeat(32)],
      ["p", viewer],
    ],
    content: "granted",
  });

  // ---- feedback: NIP-ER reminders, self-encrypted ---------------------------
  const reminder = (
    d: string,
    dueS: number,
    channelId: string,
    author: Agent,
    preview: string,
  ) =>
    push({
      kind: 30300,
      pubkey: viewer,
      created_at: nowS - 7 * 86_400,
      tags: [
        ["d", d],
        ["not_before", String(dueS)],
        ["alt", "Encrypted reminder"],
      ],
      content: sealed(viewerKey, viewer, {
        status: "pending",
        target: {
          eventId: hexId(9000 + seq, "f"),
          channelId,
          preview,
          authorPubkey: author.pubkey,
        },
      }),
    });
  reminder(
    "rem-esp32",
    nowS - 6 * 86_400,
    c["dm-esp32"],
    agents.esp32,
    "XiaoZhi firmware is flashed and running on the dev board. Before I start audio tuning I need you to pick a wake word — the three candidates are in the thread, and each one changes the mic gain profile I tune against, so I would rather not guess.",
  );
  reminder(
    "rem-zombies",
    nowS - 12 * 3_600,
    c["dm-gilfoyle"],
    agents.gilfoyle,
    "Finished the 106-folder inventory of ~/software_development. Eleven of them are zombie repos with no commits since March and no deploy target. I want a yes before I delete them; the list and the last-commit dates are in the sheet I attached.",
  );
  reminder(
    "rem-upcoming",
    nowS + 3 * 3_600,
    c.mobile,
    agents.crash,
    "TestFlight build 412 is uploading.",
  );
  if (options.dueInS !== undefined) {
    reminder(
      "rem-due-soon",
      nowS + options.dueInS,
      c.design,
      agents.gilfoyle,
      "Review the Work rail spacing before the 3 PM design sync.",
    );
  }

  // ---- observer frames: the viewer's own agents, mid-turn --------------------
  // `createdAt` a little AHEAD of now so the rows are still inside the 25 s
  // liveness budget when the page has signed in and the shot is taken.
  const beat = nowS + 20;
  const turn = (
    who: Agent,
    turnId: string,
    channelId: string | null,
    startedS: number,
    lastBeatS: number,
    triggers: string[] = [],
  ) => {
    const startedAt = new Date(startedS * 1000).toISOString();
    const frame = (kind: string, atS: number, payload: unknown) =>
      push({
        kind: 24200,
        pubkey: who.pubkey,
        created_at: atS,
        tags: [
          ["p", viewer],
          ["agent", who.pubkey],
        ],
        content: sealed(who.secretKey, viewer, {
          seq: seq,
          timestamp: new Date(atS * 1000).toISOString(),
          kind,
          agentIndex: 0,
          channelId,
          sessionId: `s-${turnId}`,
          turnId,
          startedAt,
          payload,
        }),
      });
    frame("turn_started", Math.max(startedS, nowS - 280), {
      source: channelId ? "channel" : "heartbeat",
      triggeringEventIds: triggers,
    });
    frame("turn_liveness", lastBeatS, null);
  };
  turn(agents.nikon, "t-nikon", flight, nowS - 100, beat, [beat3.id]);
  turn(agents.acid, "t-acid", c.engineering, nowS - 12 * 60, beat);
  turn(agents.jared, "t-jared", null, nowS - 3 * 60, beat);
  turn(agents.crash, "t-crash", c.mobile, nowS - 7 * 60, beat);
  // One agent stopped reporting 80 s ago: stalled, and still listed.
  turn(agents.gilfoyle, "t-gilfoyle", c.design, nowS - 5 * 60, nowS - 80);

  // ---- queued: 👀 with no 💬 (the mock needs the `h` a real relay derives) ---
  const eyes = (
    who: Agent,
    target: MockEvent,
    channelId: string,
    agoS: number,
  ) =>
    push({
      kind: 7,
      pubkey: who.pubkey,
      created_at: nowS - agoS,
      tags: [
        ["e", target.id],
        ["h", channelId],
      ],
      content: "👀",
    });
  eyes(agents.cereal, ask, flight, 90);
  eyes(agents.cereal, qa, c.engineering, 60);

  // ---- done today: 44200 turn metrics, agent → owner -------------------------
  const metric = (
    who: Agent,
    turnId: string,
    channelId: string,
    agoS: number,
  ) =>
    push({
      kind: 44200,
      pubkey: who.pubkey,
      created_at: nowS - agoS,
      tags: [
        ["p", viewer],
        ["agent", who.pubkey],
      ],
      content: sealed(who.secretKey, viewer, {
        harness: "claude",
        model: "claude-opus",
        channelId,
        sessionId: `s-${turnId}`,
        turnId,
        timestamp: new Date((nowS - agoS) * 1000).toISOString(),
        stopReason: "end_turn",
      }),
    });
  metric(agents.acid, "done-1", c.engineering, 40);
  metric(agents.gilfoyle, "done-2", flight, 30);
  metric(agents.nikon, "done-3", flight, 10);

  if (options.phase2) {
    seedPhase2(push, { viewer, agents, channels: c, nowS });
  }

  return { viewerKey, viewer, agents, channels: c, events };
}

/** Phase 2 seeds — see `buildWorkFixture`'s `phase2` option. */
function seedPhase2(
  push: (event: Partial<MockEvent>) => MockEvent,
  context: {
    viewer: string;
    agents: Record<string, Agent>;
    channels: Record<string, string>;
    nowS: number;
  },
): void {
  const { viewer, agents, channels: c, nowS } = context;
  const flight = c["flight-path"];
  // The member roster (kind 39002): the header's facepile and the @ list
  // a /handoff seat is picked from.
  push({
    kind: 39002,
    pubkey: RELAY,
    created_at: nowS - 86_400,
    tags: [
      ["d", flight],
      ["p", viewer],
      ["p", agents.gilfoyle.pubkey],
      ["p", agents.nikon.pubkey],
      ["p", agents.acid.pubkey],
      ["p", agents.cereal.pubkey],
    ],
  });
  // Callouts, between the table and the viewer's note to Nikon.
  push({
    kind: 9,
    pubkey: agents.gilfoyle.pubkey,
    created_at: nowS - 300,
    tags: [["h", flight]],
    content:
      "Capture notes for beat 02.\n\n" +
      "> [!NOTE]\n> The header settle only replays on a cold start — relaunch between takes.\n\n" +
      "> [!WARNING]\n> Reduce Motion skips the cursor ease. Record with it off.",
  });
  // Three attachments alone in one paragraph: one tile group.
  const blob = (n: string) => `https://blob.buzz.test/${n.repeat(64)}`;
  push({
    kind: 9,
    pubkey: agents.gilfoyle.pubkey,
    created_at: nowS - 260,
    tags: [
      ["h", flight],
      [
        "imeta",
        `url ${blob("a")}`,
        "m application/pdf",
        "size 482133",
        "filename capture-plan.pdf",
      ],
      [
        "imeta",
        `url ${blob("b")}`,
        "m text/csv",
        "size 2210",
        "filename beats.csv",
      ],
      [
        "imeta",
        `url ${blob("c")}`,
        "m text/markdown",
        "size 9120",
        "filename handoff-notes.md",
      ],
    ],
    content:
      `[capture-plan.pdf](${blob("a")}) [beats.csv](${blob("b")}) ` +
      `[handoff-notes.md](${blob("c")})`,
  });
  // A /handoff the seat has picked up (💬 = responding).
  const handoff = push({
    kind: 9,
    pubkey: viewer,
    created_at: nowS - 180,
    tags: [
      ["h", flight],
      ["p", agents.nikon.pubkey],
      ["handoff", agents.nikon.pubkey],
    ],
    content: "@Lord Nikon final capture pass on beat 02, slow cursor.",
  });
  push({
    kind: 7,
    pubkey: agents.nikon.pubkey,
    created_at: nowS - 170,
    tags: [
      ["e", handoff.id],
      ["h", flight],
    ],
    content: "💬",
  });
  // An explicit yes/no ask in the Gilfoyle DM (quick replies).
  push({
    kind: 9,
    pubkey: agents.gilfoyle.pubkey,
    created_at: nowS - 5 * 60,
    tags: [
      ["h", c["dm-gilfoyle"]],
      ["p", viewer],
    ],
    content:
      "Try Sol max on 1–2 more big one-shot builds before 10/8, to see whether the game win repeats?\n\nReply yes or no.",
  });
  // A three-question interview in the ESP32 DM (PhoneAsk).
  push({
    kind: 9,
    pubkey: agents.esp32.pubkey,
    created_at: nowS - 2 * 60,
    tags: [
      ["h", c["dm-esp32"]],
      ["p", viewer],
      [
        "card",
        JSON.stringify({
          v: 2,
          title: "XiaoZhi setup",
          questions: [
            {
              id: "lang",
              header: "Language",
              question: "Which language should XiaoZhi speak?",
              options: [
                { id: "en", label: "English" },
                { id: "zh", label: "Mandarin" },
              ],
            },
            {
              id: "wake",
              header: "Wake word",
              question: "Which wake word should XiaoZhi listen for?",
              options: [
                {
                  id: "buzz",
                  label: "Hey Buzz",
                  description:
                    "Two syllables. Fewest false triggers in the bench test.",
                  recommended: true,
                },
                {
                  id: "stock",
                  label: "Hi XiaoZhi",
                  description: "Stock wake word, no retraining. Harder to say.",
                },
                {
                  id: "computer",
                  label: "Computer",
                  description:
                    "Fun, but TV audio set it off 6 times in an hour.",
                },
              ],
            },
            {
              id: "vol",
              header: "Volume",
              question: "Speaker volume after boot?",
              options: [
                { id: "lo", label: "Low" },
                { id: "mid", label: "Medium" },
                { id: "hi", label: "High" },
              ],
            },
          ],
        }),
      ],
    ],
    content:
      "**XiaoZhi setup**\n\n1. Which language should XiaoZhi speak?\n2. Which wake word should XiaoZhi listen for?\n3. Speaker volume after boot?",
  });
}

/** The usage hub, answered from a fixture (A 62 %, B 48 % → 45 % free). */
export async function routeUsageHub(
  page: Page,
  nowMs = Date.now(),
): Promise<void> {
  const inHours = (hours: number) =>
    new Date(nowMs + hours * 3_600_000).toISOString();
  await page.route("**/v1/pace", (route) =>
    route.fulfill({
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({
        v: 1,
        computedAt: new Date(nowMs - 12_000).toISOString(),
        status: "warn",
        nextReset: { account: "A", resetsAt: inHours(1.5) },
        headroomAccounts: 1,
        headroomPartial: false,
        accounts: [
          {
            id: "A",
            isDefault: true,
            inUse: true,
            state: "known",
            usedFraction: 0.62,
            resetsAt: inHours(1.5),
            elapsedFraction: 0.71,
            projectedAtReset: 0.87,
            etaFullAt: null,
            basis: "trailing-24h",
            status: "ok",
          },
          {
            id: "B",
            isDefault: false,
            inUse: true,
            state: "known",
            usedFraction: 0.48,
            resetsAt: inHours(3.5),
            elapsedFraction: 0.3,
            projectedAtReset: 1.6,
            etaFullAt: inHours(1.7),
            basis: "trailing-24h",
            status: "warn",
          },
        ],
      }),
    }),
  );
  await page.route("**/v1/runway", (route) =>
    route.fulfill({
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({
        freeFraction: 0.45,
        ratePerActiveHour: 0.16,
        activeHours: 18,
        runwayHours: 2.8333,
        basis: "weeklyAll",
        computedAt: new Date(nowMs - 12_000).toISOString(),
      }),
    }),
  );
  // The reminder summary bridge: long previews come back as one line.
  await page.route("**/summarize", async (route) => {
    const text = String(
      (route.request().postDataJSON() as { text?: string } | null)?.text ?? "",
    );
    await route.fulfill({
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({
        summary: text.startsWith("XiaoZhi")
          ? "XiaoZhi firmware is running; pick a wake word before audio tuning"
          : "106-folder inventory; wants a yes on deleting zombie repos",
      }),
    });
  });
}
