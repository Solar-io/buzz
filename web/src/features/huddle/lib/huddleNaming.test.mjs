import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildHuddleChannelName,
  formatHuddleActionError,
} from "./huddleNaming.ts";

const NAMES = {
  self: "Sam Gallant",
  ada: "Ada Lovelace",
  grace: "Grace Hopper",
};
const labelOf = (pubkey) => NAMES[pubkey] ?? pubkey;

test("a channel huddle is named after the channel", () => {
  assert.equal(
    buildHuddleChannelName({
      channelType: "stream",
      channelName: "design",
      labelOf,
    }),
    "design huddle",
  );
});

test("a nameless channel still gets a name", () => {
  assert.equal(
    buildHuddleChannelName({
      channelType: "stream",
      channelName: "   ",
      labelOf,
    }),
    "huddle",
  );
});

test("a DM huddle names its people by first name", () => {
  assert.equal(
    buildHuddleChannelName({
      channelType: "dm",
      channelName: "",
      participantPubkeys: ["ada", "self"],
      currentPubkey: "self",
      labelOf,
    }),
    "Sam <> Ada huddle",
  );
});

test("the viewer leads the DM name even when listed second", () => {
  const asSam = buildHuddleChannelName({
    channelType: "dm",
    channelName: "",
    participantPubkeys: ["ada", "self"],
    currentPubkey: "self",
    labelOf,
  });
  const asAda = buildHuddleChannelName({
    channelType: "dm",
    channelName: "",
    participantPubkeys: ["ada", "self"],
    currentPubkey: "ada",
    labelOf,
  });
  assert.equal(asSam, "Sam <> Ada huddle");
  assert.equal(asAda, "Ada <> Sam huddle");
});

test("a viewer who is not a participant does not reorder the name", () => {
  assert.equal(
    buildHuddleChannelName({
      channelType: "dm",
      channelName: "",
      participantPubkeys: ["ada", "grace"],
      currentPubkey: "self",
      labelOf,
    }),
    "Ada <> Grace huddle",
  );
});

test("a group DM lists everyone", () => {
  assert.equal(
    buildHuddleChannelName({
      channelType: "dm",
      channelName: "",
      participantPubkeys: ["self", "ada", "grace"],
      currentPubkey: "self",
      labelOf,
    }),
    "Sam <> Ada <> Grace huddle",
  );
});

test("an empty DM falls back rather than producing a bare separator", () => {
  assert.equal(
    buildHuddleChannelName({
      channelType: "dm",
      channelName: "",
      participantPubkeys: [],
      labelOf,
    }),
    "huddle",
  );
});

test("the audio-unavailable code becomes something a person can act on", () => {
  const message = formatHuddleActionError(
    new Error("huddle_audio_unavailable"),
    "join",
  );
  assert.match(message, /administrator/);
  assert.equal(message.includes("huddle_audio_unavailable"), false);
});

test("the long-form audio-unavailable message maps too", () => {
  assert.match(
    formatHuddleActionError(
      "Huddle audio unavailable in this deployment",
      "start",
    ),
    /administrator/,
  );
});

test("any other relay message is shown as-is", () => {
  assert.equal(
    formatHuddleActionError(new Error("restricted: not a member"), "join"),
    "restricted: not a member",
  );
});

test("an error with nothing to say still names the action", () => {
  assert.equal(
    formatHuddleActionError(null, "join"),
    "Couldn't join the huddle.",
  );
  assert.equal(
    formatHuddleActionError(new Error("  "), "start"),
    "Couldn't start the huddle.",
  );
});
