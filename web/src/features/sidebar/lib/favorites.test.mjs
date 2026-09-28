import assert from "node:assert/strict";
import { test } from "node:test";
import { favoriteRefFor, sectionSidebar } from "./favorites.ts";

// Minimal fixtures — sectionSidebar reads ids only; the rest of each shape is
// carried through untouched, which the identity checks below pin.
const stream = (id) => ({ id, name: id, type: "stream" });
const forum = (id) => ({ id, name: id, type: "forum" });
const dm = (id) => ({
  channel: { id, participantPubkeys: [] },
  lastMessage: null,
});
const shortcut = (id) => ({
  id,
  label: `L-${id}`,
  url: "https://x.test/",
  mode: "window",
});

const world = {
  streams: [stream("alpha"), stream("beta"), stream("gamma")],
  forums: [forum("f-ideas"), forum("f-bugs")],
  dms: [dm("dm-sam"), dm("dm-evie")],
  shortcuts: [shortcut("sc:1"), shortcut("sc:2")],
};

const ids = (list) => list.map((item) => item.id ?? item.channel.id);

test("nothing favorited: every home section is whole and Favorites is empty", () => {
  const s = sectionSidebar({ ...world, favorites: [] });
  assert.deepEqual(s.favorites, []);
  assert.deepEqual(ids(s.channels), ["alpha", "beta", "gamma"]);
  assert.deepEqual(ids(s.forums), ["f-ideas", "f-bugs"]);
  assert.deepEqual(ids(s.dms), ["dm-sam", "dm-evie"]);
  assert.deepEqual(ids(s.links), ["sc:1", "sc:2"]);
});

test("a favorited DM leaves Direct messages and appears in Favorites as a DM", () => {
  const s = sectionSidebar({
    ...world,
    favorites: [{ kind: "channel", id: "dm-evie" }],
  });
  assert.deepEqual(ids(s.dms), ["dm-sam"]);
  assert.equal(s.favorites.length, 1);
  assert.equal(s.favorites[0].kind, "dm");
  assert.equal(s.favorites[0].dm, world.dms[1], "the DM's own summary");
  assert.deepEqual(
    ids(s.channels),
    ["alpha", "beta", "gamma"],
    "others untouched",
  );
});

test("a favorited forum leaves Forums and appears in Favorites as a forum", () => {
  const s = sectionSidebar({
    ...world,
    favorites: [{ kind: "channel", id: "f-bugs" }],
  });
  assert.deepEqual(ids(s.forums), ["f-ideas"]);
  assert.deepEqual(
    s.favorites.map((item) => [item.kind, item.key]),
    [["forum", "f-bugs"]],
  );
});

test("a favorited link leaves Links and appears in Favorites as a link", () => {
  const s = sectionSidebar({
    ...world,
    favorites: [{ kind: "link", id: "sc:2" }],
  });
  assert.deepEqual(ids(s.links), ["sc:1"]);
  assert.equal(s.favorites.length, 1);
  assert.equal(s.favorites[0].kind, "link");
  assert.equal(s.favorites[0].shortcut, world.shortcuts[1]);
  assert.deepEqual(favoriteRefFor(s.favorites[0]), {
    kind: "link",
    id: "sc:2",
  });
});

test("a favorited channel leaves Channels (the old Starred behavior)", () => {
  const s = sectionSidebar({
    ...world,
    favorites: [{ kind: "channel", id: "beta" }],
  });
  assert.deepEqual(ids(s.channels), ["alpha", "gamma"]);
  assert.deepEqual(
    s.favorites.map((item) => [item.kind, item.key]),
    [["channel", "beta"]],
  );
  assert.deepEqual(favoriteRefFor(s.favorites[0]), {
    kind: "channel",
    id: "beta",
  });
});

test("Favorites follow add order across kinds, not name or section order", () => {
  const s = sectionSidebar({
    ...world,
    favorites: [
      { kind: "link", id: "sc:1" },
      { kind: "channel", id: "gamma" },
      { kind: "channel", id: "dm-sam" },
      { kind: "channel", id: "f-ideas" },
      { kind: "channel", id: "alpha" },
    ],
  });
  assert.deepEqual(
    s.favorites.map((item) => [item.kind, item.key]),
    [
      ["link", "link:sc:1"],
      ["channel", "gamma"],
      ["dm", "dm-sam"],
      ["forum", "f-ideas"],
      ["channel", "alpha"],
    ],
  );
  assert.deepEqual(ids(s.channels), ["beta"]);
  assert.deepEqual(ids(s.dms), ["dm-evie"]);
  assert.deepEqual(ids(s.forums), ["f-bugs"]);
  assert.deepEqual(ids(s.links), ["sc:2"]);
});

test("favorites that resolve to nothing render nowhere and remove nothing", () => {
  const s = sectionSidebar({
    ...world,
    favorites: [
      { kind: "channel", id: "left-channel" },
      { kind: "link", id: "sc:99" },
      // A link ref never matches a channel with the same id, nor vice versa.
      { kind: "link", id: "alpha" },
      { kind: "channel", id: "sc:1" },
    ],
  });
  assert.deepEqual(s.favorites, []);
  assert.deepEqual(ids(s.channels), ["alpha", "beta", "gamma"]);
  assert.deepEqual(ids(s.links), ["sc:1", "sc:2"]);
});

test("a duplicate ref renders once", () => {
  const s = sectionSidebar({
    ...world,
    favorites: [
      { kind: "channel", id: "beta" },
      { kind: "channel", id: "beta" },
      { kind: "link", id: "sc:1" },
      { kind: "link", id: "sc:1" },
    ],
  });
  assert.deepEqual(
    s.favorites.map((item) => item.key),
    ["beta", "link:sc:1"],
  );
});
