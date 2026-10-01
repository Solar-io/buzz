import { hexId, type MockEvent, mockEvent } from "./mockRelay";
import type { WorkFixture } from "./workFixture";

/**
 * Items (kind 30623) for the Items page, faked at the relay boundary: the
 * Items artboard's rows with their real titles, summaries, owners and ages,
 * the messages they were captured from, rosters for the channels a handoff
 * can be posted in, and a generator for the 150-item filtering fixture.
 *
 * Heads are shaped exactly as `crates/buzz-sdk/src/items.rs` emits them, so
 * the web's own validator (a mirror of the relay's) accepts them.
 */

const RELAY = "ee".repeat(32);
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
export const PIPELINES = "10000000-0000-4000-8000-000000000007";

/** A stable, random-looking 12-character item id from a seed. */
export function itemId(seed: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const character of seed) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  let out = "";
  for (let i = 0; i < 12; i += 1) {
    out += ALPHABET[Number(hash & 31n)];
    hash >>= 5n;
  }
  return out;
}

export interface ItemSpec {
  seed: string;
  type: "bug" | "backlog";
  status: "open" | "progress" | "needs-you" | "done";
  title: string;
  summary?: string;
  body?: string;
  channel: string | null;
  reporter: string;
  owner?: string;
  /** The head's author (defaults to the reporter). */
  author?: string;
  project?: string;
  createdAgoS: number;
  updatedAgoS?: number;
  source?: string;
}

let eventSeq = 40_000;

export function itemHead(spec: ItemSpec, nowS: number): MockEvent {
  const created = nowS - spec.createdAgoS;
  const tags: string[][] = [["d", itemId(spec.seed)]];
  if (spec.channel) {
    tags.push(["h", spec.channel]);
  }
  tags.push(
    ["type", spec.type],
    ["status", spec.status],
    ["title", spec.title],
  );
  if (spec.summary) {
    tags.push(["summary", spec.summary]);
  }
  tags.push(["created", String(created)], ["p", spec.reporter, "", "reporter"]);
  if (spec.owner) {
    tags.push(["p", spec.owner, "", "owner"]);
  }
  if (spec.source) {
    tags.push(["e", spec.source, "", "source"]);
  }
  if (spec.project) {
    tags.push(["project", spec.project]);
  }
  eventSeq += 1;
  return mockEvent({
    id: hexId(eventSeq, "a"),
    pubkey: spec.author ?? spec.reporter,
    kind: 30623,
    created_at: nowS - (spec.updatedAgoS ?? spec.createdAgoS),
    tags,
    content: spec.body ?? "",
  });
}

/** The artboard's items, their source messages and the rosters around them. */
export function artboardItems(
  fixture: WorkFixture,
  nowS = Math.floor(Date.now() / 1000),
): { events: MockEvent[]; ids: Record<string, string> } {
  const { agents: a, channels: c, viewer } = fixture;
  const events: MockEvent[] = [];
  let seq = 30_000;
  const next = () => {
    seq += 1;
    return seq;
  };
  const message = (
    channel: string,
    pubkey: string,
    agoS: number,
    content: string,
  ) => {
    seq += 1;
    const event = mockEvent({
      id: hexId(seq, "b"),
      pubkey,
      kind: 9,
      created_at: nowS - agoS,
      tags: [["h", channel]],
      content,
    });
    events.push(event);
    return event.id;
  };
  const roster = (channel: string, members: string[]) =>
    events.push(
      mockEvent({
        id: hexId(next(), "c"),
        pubkey: RELAY,
        kind: 39002,
        created_at: nowS - 86_400,
        tags: [["d", channel], ...members.map((pubkey) => ["p", pubkey])],
      }),
    );
  events.push(
    mockEvent({
      id: hexId(next(), "c"),
      pubkey: RELAY,
      kind: 39000,
      created_at: nowS - 86_400,
      tags: [
        ["d", PIPELINES],
        ["name", "pipelines"],
        ["about", "YouTube to Thunk"],
        ["t", "stream"],
      ],
    }),
  );
  roster(c.engineering, [viewer, a.nikon.pubkey, a.acid.pubkey]);
  roster(c.mobile, [viewer, a.crash.pubkey, a.acid.pubkey]);
  roster(c.ops, [viewer, a.gilfoyle.pubkey, a.nikon.pubkey]);
  roster(PIPELINES, [viewer, a.jared.pubkey]);

  const specs: ItemSpec[] = [
    {
      seed: "88",
      type: "bug",
      status: "progress",
      title: "Composer drops the draft when switching into a scratch channel",
      summary:
        "The draft is discarded when the channel key changes mid-edit. Repro steps attached.",
      project: "Buzz web",
      channel: c["flight-path"],
      reporter: a.acid.pubkey,
      owner: a.acid.pubkey,
      createdAgoS: 2 * 3600,
      updatedAgoS: 14 * 60,
      source: message(
        c["flight-path"],
        a.acid.pubkey,
        2 * 3600,
        "Reproduced. The draft is dropped when the channel key changes mid-edit. Typing in #flight-path, then /new, loses everything in the box. Filing as P2.",
      ),
    },
    {
      seed: "87",
      type: "backlog",
      status: "progress",
      title: "Jump autocomplete for channels and DMs",
      summary: "Inline completion in ⌘K, Tab to accept, # @ / to scope.",
      body: "From the search dialog, autocomplete on DM and channel names so I can jump quickly.",
      project: "Buzz web",
      channel: c["flight-path"],
      reporter: viewer,
      owner: a.cereal.pubkey,
      author: a.cereal.pubkey,
      createdAgoS: 3600,
      updatedAgoS: 40 * 60,
    },
    {
      seed: "86",
      type: "backlog",
      status: "open",
      title: "Scratch channels keep the parent's pinned agents",
      summary: "/new copies members and agents only, never history.",
      project: "Buzz web",
      channel: c["flight-path"],
      reporter: viewer,
      createdAgoS: 20 * 60,
    },
    {
      seed: "85",
      type: "backlog",
      status: "open",
      title: "Run Sol max on 1–2 more one-shot builds",
      summary: "Check whether the RTS win repeats before the 10/8 call.",
      project: "Evals",
      channel: c["dm-gilfoyle"],
      reporter: a.gilfoyle.pubkey,
      owner: a.gilfoyle.pubkey,
      createdAgoS: 30 * 60,
      source: message(
        c["dm-gilfoyle"],
        a.gilfoyle.pubkey,
        31 * 60,
        "Want me to try Sol max on 1–2 more big one-shot builds before 10/8, so we know whether the game win repeats or was a one-off?",
      ),
    },
    {
      // No summary tag: the line under the title comes from the bridge.
      seed: "84",
      type: "bug",
      status: "open",
      title: "Round-2 decision card missing from Asks on phone",
      project: "Buzz web",
      channel: c.mobile,
      reporter: a.crash.pubkey,
      createdAgoS: 26 * 3600,
      source: message(
        c.mobile,
        a.crash.pubkey,
        26 * 3600,
        "Round 2 of the card lands in the thread, but the Asks list on phone only reads timeline rows, so it never shows up there. A card replying to an answer folds into round 1's thread, and the phone never renders the thread panel.",
      ),
    },
    {
      seed: "83",
      type: "backlog",
      status: "open",
      title: "GPU and memory in the sidebar Vitals",
      summary: "Thin-line metrics for crichton stacked under Claude usage.",
      project: "Buzz web",
      channel: c.ops,
      reporter: viewer,
      createdAgoS: 2 * 3600 + 300,
    },
    {
      seed: "82",
      type: "backlog",
      status: "needs-you",
      title: "Prune pilot snapshots older than 30 days",
      summary:
        "pilot disk is at 81%. The delete list is ready and waiting on your approval.",
      project: "Infra",
      channel: c.ops,
      reporter: a.gilfoyle.pubkey,
      owner: a.gilfoyle.pubkey,
      createdAgoS: 2 * 86_400,
      source: message(
        c.ops,
        a.gilfoyle.pubkey,
        2 * 86_400,
        "Disk on pilot is at 81%. I can prune snapshots older than 30 days (list attached) or you can grow the volume. Need a yes on the list.",
      ),
    },
    {
      seed: "81",
      type: "bug",
      status: "progress",
      title: "TTS bridge stalls after about 40 min of playback",
      summary:
        "The jitter buffer drains faster than Chatterbox refills; audio stops with no error.",
      project: "Buzz web",
      channel: c.engineering,
      reporter: a.nikon.pubkey,
      owner: a.nikon.pubkey,
      createdAgoS: 3 * 86_400,
      updatedAgoS: 3 * 3600,
      source: message(
        c.engineering,
        a.nikon.pubkey,
        3 * 86_400,
        "Long huddles go silent around the 40 minute mark. The jitter buffer runs dry and never recovers.",
      ),
    },
    {
      seed: "80",
      type: "backlog",
      status: "open",
      title: "Tag Thunk notes by YouTube channel",
      summary:
        "Add the source channel as a tag when the pipeline writes each note.",
      project: "Thunk",
      channel: PIPELINES,
      reporter: a.jared.pubkey,
      createdAgoS: 4 * 86_400,
    },
    {
      seed: "79",
      type: "bug",
      status: "open",
      title: "Reminder “open” lands on the channel, not the message",
      summary:
        "The deep link drops the message id, so you arrive at the bottom of the channel.",
      project: "Buzz web",
      channel: c["dm-esp32"],
      reporter: viewer,
      createdAgoS: 6 * 86_400,
    },
    {
      seed: "78",
      type: "backlog",
      status: "needs-you",
      title: "XiaoZhi wake-word tuning",
      summary:
        "Firmware runs on the ESP32-S3. Needs a wake word picked before audio tuning.",
      project: "ESP32",
      channel: c["dm-esp32"],
      reporter: a.esp32.pubkey,
      owner: a.esp32.pubkey,
      createdAgoS: 6 * 86_400 + 420,
    },
    {
      seed: "77",
      type: "bug",
      status: "done",
      title: "Huddle chat drops the first message after joining",
      summary:
        "The subscription opened after the first frame; fixed by subscribing on join.",
      project: "Buzz web",
      channel: c.engineering,
      reporter: a.nikon.pubkey,
      owner: a.nikon.pubkey,
      createdAgoS: 7 * 86_400,
      updatedAgoS: 5 * 86_400,
    },
    {
      // Filed from a shell: no channel, visible to everyone.
      seed: "76",
      type: "backlog",
      status: "open",
      title: "Nightly restore test for the crichton backups",
      summary: "Restore last night's snapshot to a scratch volume and diff it.",
      project: "Infra",
      channel: null,
      reporter: a.gilfoyle.pubkey,
      createdAgoS: 8 * 86_400,
    },
  ];
  const ids: Record<string, string> = {};
  for (const spec of specs) {
    ids[spec.seed] = itemId(spec.seed);
    events.push(itemHead(spec, nowS));
  }
  // Item 87 was filed by Sam and picked up by Cereal Killer: Sam's own
  // (older) head is still on the relay beside the newer one.
  events.push(
    itemHead(
      {
        ...specs[1],
        status: "open",
        owner: undefined,
        author: undefined,
        updatedAgoS: 3600,
      },
      nowS,
    ),
  );
  return { events, ids };
}

/** `n` items across the fixture's channels, for the filtering budget. */
export function manyItems(
  fixture: WorkFixture,
  n: number,
  nowS = Math.floor(Date.now() / 1000),
): MockEvent[] {
  const channels = [
    fixture.channels["flight-path"],
    fixture.channels.engineering,
    fixture.channels.mobile,
    fixture.channels.ops,
  ];
  const agents = Object.values(fixture.agents);
  const statuses = ["open", "progress", "needs-you", "done"] as const;
  const topics = [
    "composer draft",
    "huddle audio",
    "sidebar vitals",
    "decision card",
    "thread reply",
    "scratch channel",
  ];
  const events: MockEvent[] = [];
  for (let i = 0; i < n; i += 1) {
    const owner = i % 3 === 0 ? undefined : agents[i % agents.length].pubkey;
    events.push(
      itemHead(
        {
          seed: `bulk-${i}`,
          type: i % 4 === 0 ? "bug" : "backlog",
          status: statuses[i % statuses.length],
          title: `${topics[i % topics.length]} item ${i}`,
          summary: `Fixture item ${i} about the ${topics[i % topics.length]}.`,
          channel: channels[i % channels.length],
          reporter: agents[(i + 1) % agents.length].pubkey,
          owner,
          project: i % 5 === 0 ? "Evals" : "Buzz web",
          createdAgoS: 600 + i * 900,
        },
        nowS,
      ),
    );
  }
  return events;
}
