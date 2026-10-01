import assert from "node:assert/strict";
import test from "node:test";

import { foldItems } from "./itemEvent.ts";
import {
  compareItems,
  DEFAULT_FILTERS,
  filterItems,
  inferProject,
  itemHaystack,
  openCounts,
  ownerOptions,
  parseTextQuery,
  projectLabel,
  projectOptions,
  sortItems,
} from "./itemsView.ts";

const ME = "a".repeat(64);
const NIKON = "b".repeat(64);
const GILFOYLE = "c".repeat(64);
const FLIGHT = "10000000-0000-4000-8000-000000000004";
const MOBILE = "10000000-0000-4000-8000-000000000005";
const SCRATCH = "30000000-0000-4000-8000-00000000000a";

const PEOPLE = { [ME]: "Sam", [NIKON]: "Lord Nikon", [GILFOYLE]: "Gilfoyle" };
const CHANNELS = { [FLIGHT]: "flight-path", [MOBILE]: "mobile" };
const names = {
  selfPubkey: ME,
  personName: (pubkey) => PEOPLE[pubkey] ?? pubkey.slice(0, 8),
  channelName: (id) => (id ? `#${CHANNELS[id] ?? ""}` : ""),
};

let seq = 0;
function item(overrides = {}) {
  seq += 1;
  const created = overrides.created ?? 1_000 + seq;
  return {
    id: `id${String(seq).padStart(10, "0")}`,
    channelId: FLIGHT,
    type: "bug",
    status: "open",
    title: `Item ${seq}`,
    summary: null,
    body: "",
    created,
    reporter: ME,
    owner: null,
    sourceEventId: null,
    projectCoordinate: null,
    projectName: null,
    updatedAt: created,
    updatedBy: ME,
    eventId: `ev${seq}`,
    ...overrides,
  };
}

const run = (items, filters = {}) =>
  filterItems(sortItems(items), { ...DEFAULT_FILTERS, ...filters }, names);

test("fold first, then filter: a reassigned item leaves its old owner's list", () => {
  const tags = (owner, status) => [
    ["d", "7f3k2m9qa1bc"],
    ["h", FLIGHT],
    ["type", "bug"],
    ["status", status],
    ["title", "Round-2 card missing from Asks"],
    ["created", "1000"],
    ["p", ME, "", "reporter"],
    ["p", owner, "", "owner"],
  ];
  const heads = [
    {
      id: "e1",
      pubkey: ME,
      kind: 30623,
      created_at: 1_000,
      content: "",
      tags: tags(NIKON, "open"),
    },
    {
      id: "e2",
      pubkey: GILFOYLE,
      kind: 30623,
      created_at: 1_100,
      content: "",
      tags: tags(GILFOYLE, "progress"),
    },
  ];
  const folded = foldItems(heads);
  assert.equal(folded.length, 1);
  assert.equal(run(folded, { owner: { pubkey: NIKON } }).rows.length, 0);
  assert.equal(run(folded, { owner: { pubkey: GILFOYLE } }).rows.length, 1);
});

test("not done is the default; the tab counts ignore the tab, not the rest", () => {
  const items = [
    item({ type: "bug", status: "open" }),
    item({ type: "bug", status: "done" }),
    item({ type: "backlog", status: "progress" }),
    item({ type: "backlog", status: "needs-you" }),
    item({ type: "backlog", status: "open", owner: NIKON }),
  ];
  const all = run(items);
  assert.equal(all.rows.length, 4);
  assert.deepEqual(all.tabCounts, { all: 4, bug: 1, backlog: 3 });
  const bugs = run(items, { tab: "bug" });
  assert.deepEqual(
    bugs.rows.map((row) => row.status),
    ["open"],
  );
  assert.deepEqual(bugs.tabCounts, { all: 4, bug: 1, backlog: 3 });
  assert.equal(run(items, { status: "all" }).rows.length, 5);
  assert.deepEqual(
    run(items, { status: "done" }).rows.map((row) => row.type),
    ["bug"],
  );
  assert.equal(run(items, { owner: "none" }).rows.length, 3);
  assert.equal(run(items, { owner: "me" }).rows.length, 0);
});

test("the text box: words, #channel and @person", () => {
  const items = [
    item({ title: "Composer drops the draft", owner: NIKON }),
    item({
      title: "TTS bridge stalls",
      channelId: MOBILE,
      summary: "jitter buffer drains",
    }),
    item({
      title: "Tag Thunk notes",
      reporter: GILFOYLE,
      projectName: "Thunk",
    }),
  ];
  const titles = (text) => run(items, { text }).rows.map((row) => row.title);
  assert.deepEqual(titles("draft"), ["Composer drops the draft"]);
  assert.deepEqual(titles("JITTER"), ["TTS bridge stalls"]);
  assert.deepEqual(titles("#mobile"), ["TTS bridge stalls"]);
  assert.deepEqual(titles("@nikon"), ["Composer drops the draft"]);
  assert.deepEqual(titles("@gilfoyle thunk"), ["Tag Thunk notes"]);
  assert.deepEqual(titles("#mobile draft"), []);
  assert.deepEqual(parseTextQuery("  #Design  @Acid bug #  "), {
    words: ["bug", "#"],
    channels: ["design"],
    people: ["acid"],
  });
  // The item id is searchable (the CLI's short id).
  const withId = item({ id: "7f3k2m9qa1bc" });
  assert.equal(run([withId], { text: "7f3k2" }).rows.length, 1);
});

test("newest filed first, then newest change, then id", () => {
  const a = item({ created: 10, updatedAt: 10, id: "aaaaaaaaaaaa" });
  const b = item({ created: 30, updatedAt: 30, id: "bbbbbbbbbbbb" });
  const c = item({ created: 20, updatedAt: 90, id: "cccccccccccc" });
  const d = item({ created: 20, updatedAt: 90, id: "0ccccccccccc" });
  const e = item({ created: 20, updatedAt: 40, id: "dddddddddddd" });
  assert.deepEqual(
    sortItems([a, b, c, d, e]).map((row) => row.id),
    [
      "bbbbbbbbbbbb",
      "0ccccccccccc",
      "cccccccccccc",
      "dddddddddddd",
      "aaaaaaaaaaaa",
    ],
  );
  assert.equal(compareItems(a, a), 0);
});

test("counts, projects and owners for the chrome", () => {
  const items = [
    item({ type: "bug" }),
    item({ type: "bug", status: "done" }),
    item({ type: "backlog", projectName: "Buzz web", owner: NIKON }),
    item({ type: "backlog", projectName: "buzz WEB", owner: NIKON }),
    item({
      type: "backlog",
      projectCoordinate: `30621:${ME}:evals`,
      owner: GILFOYLE,
    }),
  ];
  assert.deepEqual(openCounts(items), { bugs: 1, backlog: 3 });
  assert.deepEqual(projectOptions(items), {
    names: ["Buzz web", "evals"],
    hasNone: true,
  });
  assert.deepEqual(ownerOptions(items), [NIKON, GILFOYLE]);
  assert.equal(projectLabel(items[4]), "evals");
  assert.equal(projectLabel(items[0]), null);
  assert.equal(run(items, { project: { name: "BUZZ web" } }).rows.length, 2);
  assert.equal(run(items, { project: "none" }).rows.length, 1);
});

test("/bug's project is the newest labelled item from this channel or its parent", () => {
  const items = [
    item({ channelId: FLIGHT, created: 10, projectName: "Old" }),
    item({
      channelId: FLIGHT,
      created: 50,
      projectName: "Buzz web",
      projectCoordinate: `30621:${ME}:web`,
    }),
    item({ channelId: FLIGHT, created: 90 }), // newest, but names no project
    item({ channelId: MOBILE, created: 99, projectName: "Mobile" }),
  ];
  assert.deepEqual(inferProject(items, [FLIGHT]), {
    name: "Buzz web",
    coordinate: `30621:${ME}:web`,
    label: "Buzz web",
  });
  // A scratch channel inherits its parent's.
  assert.equal(inferProject(items, [SCRATCH, FLIGHT])?.label, "Buzz web");
  assert.equal(inferProject(items, [SCRATCH]), null);
});

test("150 items filter well inside the 100 ms budget", () => {
  const items = [];
  for (let i = 0; i < 150; i += 1) {
    items.push(
      item({
        type: i % 3 === 0 ? "bug" : "backlog",
        status: ["open", "progress", "needs-you", "done"][i % 4],
        title: `Item number ${i} about ${i % 2 ? "composer drafts" : "huddle audio"}`,
        summary: i % 5 === 0 ? "A summary worth searching" : null,
        owner: i % 2 ? NIKON : null,
        channelId: i % 2 ? FLIGHT : MOBILE,
        projectName: i % 7 === 0 ? "Buzz web" : null,
      }),
    );
  }
  const sorted = sortItems(items);
  const haystacks = new Map(
    sorted.map((row) => [row, itemHaystack(row, names)]),
  );
  const started = performance.now();
  let shown = 0;
  for (const text of [
    "",
    "c",
    "co",
    "com",
    "composer",
    "#flight",
    "@nikon composer",
  ]) {
    for (const tab of ["all", "bug", "backlog"]) {
      shown += filterItems(
        sorted,
        { ...DEFAULT_FILTERS, tab, text },
        names,
        (row) => haystacks.get(row) ?? "",
      ).rows.length;
    }
  }
  const elapsed = performance.now() - started;
  assert.ok(shown > 0);
  // 21 full filter passes; each one must be far inside the 100 ms budget.
  assert.ok(elapsed / 21 < 10, `${(elapsed / 21).toFixed(2)} ms per pass`);
});
