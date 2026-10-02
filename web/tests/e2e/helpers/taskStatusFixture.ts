import { generateSecretKey, getPublicKey } from "nostr-tools/pure";

import { hexId, type MockEvent, mockEvent } from "./mockRelay";
import type { WorkFixture } from "./workFixture";

/**
 * Phase 8 on top of the Work fixture: kind-30624 task status heads and a
 * PR-merge ask, served as `openShell({ extra })` so the Phase 1 counts the
 * `work-shell` spec pins stay untouched.
 *
 * The heads are shaped the way the harness and `buzz status set` write them
 * (`buzz-core/src/task_status.rs`), one lifecycle head per (agent, channel)
 * as a real relay would hold it — the addressable replace is the RELAY's job,
 * so a fixture that served two heads for one `d` would test a client
 * behaviour no relay produces.
 *
 *   Lord Nikon   #flight-path  running, same turn as its observer frames,
 *                              "Capture pass" 1/3          → one merged row
 *   Acid Burn    #engineering  running, "Jitter buffer QA" 4/7 → "4 of 7"
 *   Crash        #mobile       running, a detail from an EARLIER turn
 *                                                          → no title (D8.3)
 *   Razor        #ops          running, not the viewer's agent, "Restore
 *                              drill" 2/3                  → status-only row
 *   Blade        #announcements running, last refreshed 400 s ago
 *                                                          → "no heartbeat"
 *   Razor        #engineering  done 5 s ago, "Merge-queue sweep" → Done, last
 *   Blade        #mobile       error, harness-restart       → Done, abnormal
 *   Gilfoyle     #flight-path  done, the SAME turn as its 44200 metric,
 *                              "Beat 01 captured"           → one Done row
 *   Jared        heartbeat     no 30624 at all              → observer fallback
 */

export interface StatusAgents {
  razor: { name: string; pubkey: string };
  blade: { name: string; pubkey: string };
}

export const PR_EVENT_ID = "4b".repeat(32);
export const PR_TITLE = "Merge feat(web): Work tab v2 status rows";
/** The message that started Crash's untitled turn (its 30624 `e` trigger). */
export const CRASH_ASK_ID = "4c".repeat(32);
export const CRASH_ASK_LINE = "Cut a TestFlight build off main";

let next = 80_000;
const id = () => hexId(next++, "5");

export function lifecycleHead(
  author: string,
  channelId: string,
  turn: string,
  state: "running" | "done" | "error" | "cancelled",
  at: number,
  started: number,
  reason?: string,
  trigger?: string,
): MockEvent {
  return mockEvent({
    id: id(),
    kind: 30624,
    pubkey: author,
    created_at: at,
    tags: [
      ["d", `turn:${channelId}`],
      ["h", channelId],
      ["turn", turn],
      ["state", state],
      ["started", String(started)],
      ...(state === "running" ? [] : [["ended", String(at)]]),
      ["session", "0"],
      ...(reason ? [["reason", reason]] : []),
      ...(trigger ? [["e", trigger, "", "trigger"]] : []),
    ],
    content: "",
  });
}

export function detailHead(
  author: string,
  channelId: string,
  turn: string,
  at: number,
  fields: { title?: string; progress?: [number, number] },
): MockEvent {
  return mockEvent({
    id: id(),
    kind: 30624,
    pubkey: author,
    created_at: at,
    tags: [
      ["d", `detail:${channelId}`],
      ["h", channelId],
      ["turn", turn],
      ...(fields.title ? [["title", fields.title]] : []),
      ...(fields.progress
        ? [["progress", String(fields.progress[0]), String(fields.progress[1])]]
        : []),
    ],
    content: "",
  });
}

export function buildTaskStatus(
  fixture: WorkFixture,
  nowS = Math.floor(Date.now() / 1000),
): { events: MockEvent[]; agents: StatusAgents } {
  const c = fixture.channels;
  const a = fixture.agents;
  const member = (name: string) => ({
    name,
    pubkey: getPublicKey(generateSecretKey()),
  });
  const agents = { razor: member("Razor"), blade: member("Blade") };
  const events: MockEvent[] = [];
  // Other members' agents: profiles only — not in the viewer's registry, and
  // no observer frames, so 30624 is the only thing that can show them.
  for (const agent of Object.values(agents)) {
    events.push(
      mockEvent({
        id: id(),
        kind: 0,
        pubkey: agent.pubkey,
        created_at: nowS - 86_400,
        content: JSON.stringify({ display_name: agent.name }),
      }),
    );
  }

  // Running — merged with the viewer's own observer turns (same turn ids).
  // `created_at` a little ahead of now, like the fixture's observer beats, so
  // the heads are still fresh when the page has signed in.
  const ahead = nowS + 20;
  events.push(
    lifecycleHead(
      a.nikon.pubkey,
      c["flight-path"],
      "t-nikon",
      "running",
      ahead,
      nowS - 100,
    ),
    detailHead(a.nikon.pubkey, c["flight-path"], "t-nikon", ahead, {
      title: "Capture pass",
      progress: [1, 3],
    }),
    lifecycleHead(
      a.acid.pubkey,
      c.engineering,
      "t-acid",
      "running",
      ahead,
      nowS - 720,
    ),
    detailHead(a.acid.pubkey, c.engineering, "t-acid", ahead, {
      title: "Jitter buffer QA",
      progress: [4, 7],
    }),
    lifecycleHead(
      a.crash.pubkey,
      c.mobile,
      "t-crash",
      "running",
      ahead,
      nowS - 420,
      undefined,
      CRASH_ASK_ID,
    ),
    // The ask behind it: blank first line, extra spaces and a second line, so
    // the row has to pick the first non-empty line and collapse whitespace.
    mockEvent({
      id: CRASH_ASK_ID,
      kind: 9,
      pubkey: fixture.viewer,
      created_at: nowS - 430,
      tags: [["h", c.mobile]],
      content: `\n  Cut a   TestFlight build\toff main  \nthen post the link here`,
    }),
    detailHead(a.crash.pubkey, c.mobile, "t-crash-previous", nowS - 600, {
      title: "Stale title from an earlier turn",
    }),
  );
  // Running — status only.
  events.push(
    lifecycleHead(
      agents.razor.pubkey,
      c.ops,
      "r-run",
      "running",
      ahead,
      nowS - 200,
    ),
    detailHead(agents.razor.pubkey, c.ops, "r-run", ahead, {
      title: "Restore drill",
      progress: [2, 3],
    }),
    lifecycleHead(
      agents.blade.pubkey,
      c.announcements,
      "b-run",
      "running",
      nowS - 400,
      nowS - 900,
    ),
    detailHead(agents.blade.pubkey, c.announcements, "b-run", nowS - 420, {
      title: "Changelog digest",
    }),
  );
  // Done today.
  events.push(
    lifecycleHead(
      agents.razor.pubkey,
      c.engineering,
      "r-done",
      "done",
      nowS - 5,
      nowS - 200,
    ),
    detailHead(agents.razor.pubkey, c.engineering, "r-done", nowS - 60, {
      title: "Merge-queue sweep",
    }),
    lifecycleHead(
      agents.blade.pubkey,
      c.mobile,
      "b-err",
      "error",
      nowS - 50,
      nowS - 300,
      "harness-restart",
    ),
    lifecycleHead(
      a.gilfoyle.pubkey,
      c["flight-path"],
      "done-2",
      "done",
      nowS - 30,
      nowS - 400,
    ),
    detailHead(a.gilfoyle.pubkey, c["flight-path"], "done-2", nowS - 300, {
      title: "Beat 01 captured",
    }),
  );

  // A PR-merge ask: a decision card carrying the CLI's `buzz pr open` link.
  events.push(
    mockEvent({
      id: id(),
      kind: 9,
      pubkey: a.cereal.pubkey,
      created_at: nowS - 4 * 60,
      tags: [
        ["h", c.engineering],
        ["p", fixture.viewer],
        [
          "card",
          JSON.stringify({
            v: 1,
            title: PR_TITLE,
            body: `Tests green, 212 passed. buzz://pr?id=${PR_EVENT_ID}&owner=${a.cereal.pubkey}&d=buzz`,
            options: [
              { label: "Approve", recommended: true },
              { label: "Hold" },
            ],
          }),
        ],
      ],
      content: `**${PR_TITLE}**\n\n- Approve *(Recommended)*\n- Hold`,
    }),
  );
  return { events, agents };
}
