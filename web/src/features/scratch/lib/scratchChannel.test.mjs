import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildScratchCreateEvent,
  buildScratchDeleteEvent,
  buildScratchKeepEvent,
  buildScratchMemberEvents,
  isScratchChannel,
  newestRoster,
  nextScratchName,
  parseScratchParent,
  scratchCountdown,
  scratchIdleDeadline,
  scratchInfo,
  scratchMemberPlan,
  withoutScratchMarker,
} from "./scratchChannel.ts";

const PARENT = "10000000-0000-4000-8000-000000000004";
const SCRATCH = "30000000-0000-4000-8000-00000000000a";
const VIEWER = "a".repeat(64);
const GILFOYLE = "b".repeat(64);
const NIKON = "c".repeat(64);
const ABOUT = `Cloned from #flight-path [parent:${PARENT}]`;
const NOW = 1_700_000_000;

test("the create event is private, carries the parent link and a 72 h idle ttl", () => {
  const built = buildScratchCreateEvent({
    channelId: SCRATCH,
    name: "flight-path-scratch-1",
    parent: { id: PARENT, name: "flight-path" },
  });
  assert.deepEqual(built, {
    event: {
      kind: 9007,
      tags: [
        ["h", SCRATCH],
        ["name", "flight-path-scratch-1"],
        ["visibility", "private"],
        ["channel_type", "stream"],
        ["about", ABOUT],
        ["ttl", "259200"],
      ],
      content: "",
    },
  });
  assert.deepEqual(
    buildScratchCreateEvent({
      channelId: SCRATCH,
      name: "  ",
      parent: { id: PARENT, name: "flight-path" },
    }),
    { error: "channel name is required" },
  );
});

test("the parent link round-trips through about, and only a UUID marker counts", () => {
  assert.equal(parseScratchParent(ABOUT), PARENT);
  assert.equal(
    parseScratchParent(`Cloned from #x [parent:${PARENT.toUpperCase()}]`),
    PARENT,
  );
  assert.equal(parseScratchParent("Cloned from #flight-path"), null);
  assert.equal(parseScratchParent("see [parent:not-a-uuid]"), null);
  assert.equal(parseScratchParent(""), null);
  assert.equal(parseScratchParent(null), null);
  assert.equal(withoutScratchMarker(ABOUT), "Cloned from #flight-path");
});

test("scratch means the parent marker AND a live ttl; a kept channel is not scratch", () => {
  const live = {
    id: SCRATCH,
    name: "flight-path-scratch-1",
    about: ABOUT,
    ttlSeconds: 259200,
  };
  assert.equal(isScratchChannel(live), true);
  assert.equal(isScratchChannel({ ...live, ttlSeconds: null }), false);
  // A huddle's backing room has a ttl and no parent marker.
  assert.equal(
    isScratchChannel({ ...live, about: "", ttlSeconds: 3600 }),
    false,
  );
});

test("scratch info names the parent from the live list, else from the about", () => {
  const channel = {
    id: SCRATCH,
    name: "flight-path-scratch-1",
    about: ABOUT,
    ttlSeconds: 259200,
  };
  assert.deepEqual(
    scratchInfo(channel, [{ id: PARENT, name: "flight-path-v2" }]),
    {
      parentId: PARENT,
      parentName: "flight-path-v2",
      label: { parent: "flight-path", rest: "scratch-1" },
    },
  );
  assert.deepEqual(scratchInfo(channel, []), {
    parentId: PARENT,
    parentName: "flight-path",
    label: { parent: "flight-path", rest: "scratch-1" },
  });
  // Renamed by hand: the whole name reads after the slash.
  assert.deepEqual(scratchInfo({ ...channel, name: "jitter" }, []).label, {
    parent: "flight-path",
    rest: "jitter",
  });
  assert.equal(scratchInfo({ ...channel, ttlSeconds: null }, []), null);
});

test("names count up past the highest scratch in use; a given name is prefixed", () => {
  assert.deepEqual(nextScratchName("flight-path", ["flight-path"], null), {
    name: "flight-path-scratch-1",
  });
  assert.deepEqual(
    nextScratchName(
      "flight-path",
      [
        "flight-path",
        "flight-path-scratch-1",
        "flight-path-scratch-4",
        "design-scratch-9",
        "flight-path-scratch-x",
      ],
      null,
    ),
    { name: "flight-path-scratch-5" },
  );
  assert.deepEqual(nextScratchName("flight-path", [], "Jitter QA"), {
    name: "flight-path-jitter-qa",
  });
  assert.deepEqual(nextScratchName("flight-path", [], "#flight-path-beat-2"), {
    name: "flight-path-beat-2",
  });
  assert.deepEqual(
    nextScratchName("flight-path", ["flight-path-jitter"], "jitter"),
    { name: "flight-path-jitter-2" },
  );
  assert.deepEqual(nextScratchName("flight-path", [], "  # "), {
    error: "Give the scratch channel a name, or leave it blank.",
  });
});

test("the member copy is the parent's whole roster minus me, at the member role", () => {
  const roster = newestRoster(
    [
      {
        kind: 39002,
        created_at: 100,
        tags: [
          ["d", PARENT],
          ["p", VIEWER, "", "owner"],
          ["p", GILFOYLE],
        ],
      },
      {
        kind: 39002,
        created_at: 200,
        tags: [
          ["d", PARENT],
          ["p", VIEWER, "", "owner"],
          ["p", GILFOYLE.toUpperCase(), "", "bot"],
          ["p", NIKON, "", "admin"],
          ["p", NIKON],
          ["p", "not-a-key"],
        ],
      },
      // Another channel's snapshot never leaks in.
      {
        kind: 39002,
        created_at: 300,
        tags: [
          ["d", "elsewhere"],
          ["p", "d".repeat(64)],
        ],
      },
    ],
    PARENT,
  );
  assert.ok(roster, "the parent's newest snapshot is found");
  const plan = scratchMemberPlan(roster.keys(), VIEWER.toUpperCase());
  assert.deepEqual(plan, [GILFOYLE, NIKON]);
  assert.deepEqual(buildScratchMemberEvents(SCRATCH, plan), [
    {
      kind: 9000,
      tags: [
        ["h", SCRATCH],
        ["p", GILFOYLE],
      ],
      content: "",
    },
    {
      kind: 9000,
      tags: [
        ["h", SCRATCH],
        ["p", NIKON],
      ],
      content: "",
    },
  ]);
  assert.equal(newestRoster([], PARENT), null);
});

test("keep clears the ttl explicitly, renaming only when asked", () => {
  assert.deepEqual(buildScratchKeepEvent(SCRATCH, null), {
    event: {
      kind: 9002,
      tags: [
        ["h", SCRATCH],
        ["ttl", ""],
      ],
      content: "",
    },
  });
  assert.deepEqual(buildScratchKeepEvent(SCRATCH, "#capture-plan "), {
    event: {
      kind: 9002,
      tags: [
        ["h", SCRATCH],
        ["ttl", ""],
        ["name", "capture-plan"],
      ],
      content: "",
    },
  });
  assert.deepEqual(buildScratchKeepEvent(SCRATCH, "#"), {
    error: "That name is empty — /keep [name].",
  });
  assert.deepEqual(buildScratchDeleteEvent(SCRATCH), {
    kind: 9008,
    tags: [["h", SCRATCH]],
    content: "",
  });
});

test("the idle deadline is the later of the stamped deadline and the last event + ttl", () => {
  const stamped = new Date((NOW + 600) * 1000).toISOString();
  const channel = { ttlSeconds: 259200, ttlDeadline: stamped };
  // A message after the stamp proves the deadline slid past it.
  assert.equal(scratchIdleDeadline(channel, NOW), NOW + 259200);
  assert.equal(scratchIdleDeadline(channel, null), NOW + 600);
  assert.equal(
    scratchIdleDeadline({ ttlSeconds: 259200, ttlDeadline: null }, NOW - 50),
    NOW - 50 + 259200,
  );
  assert.equal(
    scratchIdleDeadline({ ttlSeconds: null, ttlDeadline: stamped }, NOW),
    null,
  );
});

test("the countdown shows only in the last hour of idle", () => {
  const deadline = (seconds) => ({
    ttlSeconds: 259200,
    ttlDeadline: new Date((NOW + seconds) * 1000).toISOString(),
  });
  assert.equal(scratchCountdown(deadline(3601), null, NOW), null);
  const hour = scratchCountdown(deadline(3600), null, NOW);
  assert.equal(hour.label, "60m left");
  assert.equal(hour.urgency, "normal");
  const soon = scratchCountdown(deadline(240), null, NOW);
  assert.equal(soon.label, "4m left");
  assert.equal(soon.urgency, "soon");
  // Recent activity pushes it back out of view.
  assert.equal(scratchCountdown(deadline(240), NOW - 10, NOW), null);
  assert.equal(scratchCountdown(deadline(-5), null, NOW).urgency, "expired");
  assert.equal(
    scratchCountdown({ ...deadline(99_999), archived: true }, null, NOW).label,
    "ended",
  );
});
