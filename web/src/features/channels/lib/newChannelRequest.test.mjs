import assert from "node:assert/strict";
import { test } from "node:test";
import { newChannelRequest } from "./newChannelRequest.ts";

const input = {
  channelId: "7b44b2f7-22a7-470c-bcee-48b254983156",
  name: "design",
  about: "",
  isPrivate: true,
  type: "stream",
  lifetime: 0,
};

test("forum + 7 days emits channel_type forum and ttl 604800", () => {
  assert.deepEqual(
    newChannelRequest({ ...input, type: "forum", lifetime: 604800 }),
    {
      event: {
        kind: 9007,
        tags: [
          ["h", input.channelId],
          ["name", "design"],
          ["visibility", "private"],
          ["channel_type", "forum"],
          ["ttl", "604800"],
        ],
        content: "",
      },
    },
  );
});

test("ongoing stream omits ttl, preserving private creation", () => {
  assert.deepEqual(newChannelRequest(input).event.tags, [
    ["h", input.channelId],
    ["name", "design"],
    ["visibility", "private"],
    ["channel_type", "stream"],
  ]);
});

for (const [lifetime, ttl] of [
  [86400, "86400"],
  [259200, "259200"],
  [604800, "604800"],
  [2592000, "2592000"],
]) {
  test(`lifetime ${lifetime} emits exactly ${ttl} seconds`, () => {
    assert.deepEqual(
      newChannelRequest({ ...input, lifetime }).event.tags.at(-1),
      ["ttl", ttl],
    );
  });
}

test("public creation canonicalizes hash/space prefixes and preserves trimmed purpose", () => {
  assert.deepEqual(
    newChannelRequest({
      ...input,
      isPrivate: false,
      name: " # # design ",
      about: " Design notes ",
    }).event.tags,
    [
      ["h", input.channelId],
      ["name", "design"],
      ["visibility", "open"],
      ["channel_type", "stream"],
      ["about", "Design notes"],
    ],
  );
});

test("blank and hash-only names refuse creation before signing", () => {
  for (const name of ["", "   ", " ## "]) {
    assert.deepEqual(newChannelRequest({ ...input, name }), {
      error: "Channel name is required.",
    });
  }
});

test("missing id and unsupported lifetimes refuse creation", () => {
  assert.deepEqual(newChannelRequest({ ...input, channelId: "" }), {
    error: "Channel id is required.",
  });
  for (const lifetime of [-1, 123, NaN]) {
    assert.deepEqual(newChannelRequest({ ...input, lifetime }), {
      error: "Choose a channel lifetime from the list.",
    });
  }
});
