import assert from "node:assert/strict";
import test from "node:test";

import {
  commandQuery,
  parseCommand,
  unknownCommandMessage,
} from "./parseCommand.ts";

test("a slash line is a command; a leading space or a path is a message", () => {
  assert.deepEqual(parseCommand("/status"), { name: "status", args: "" });
  assert.deepEqual(parseCommand("/remind 2h"), { name: "remind", args: "2h" });
  assert.deepEqual(parseCommand("/Handoff  @Lord Nikon  capture pass "), {
    name: "handoff",
    args: "@Lord Nikon  capture pass",
  });
  // Arguments may span lines; the name is still the first token.
  assert.deepEqual(parseCommand("/handoff @A one\ntwo"), {
    name: "handoff",
    args: "@A one\ntwo",
  });
  // A bare slash is a command with no name yet — Enter must not post "/".
  assert.deepEqual(parseCommand("/"), { name: "", args: "" });

  // Messages. None of these may be swallowed as a command.
  assert.equal(parseCommand(" /status"), null);
  assert.equal(parseCommand("/usr/local/bin is missing"), null);
  assert.equal(parseCommand("/5 done"), null);
  assert.equal(parseCommand("/ and then"), null);
  assert.equal(parseCommand("see /status"), null);
  assert.equal(parseCommand("hello"), null);
  assert.equal(parseCommand(""), null);
});

test("an unknown name still parses as a command, never as text", () => {
  assert.deepEqual(parseCommand("/remnid 2h"), { name: "remnid", args: "2h" });
  assert.deepEqual(parseCommand("/etc is broken"), {
    name: "etc",
    args: "is broken",
  });
});

test("commandQuery is the partial name while the caret is in the first token", () => {
  assert.equal(commandQuery("/", 1), "");
  assert.equal(commandQuery("/re", 3), "re");
  assert.equal(commandQuery("/REMIND", 7), "remind");
  // Caret mid-token, before a space: still the first token up to the caret.
  assert.equal(commandQuery("/remind 2h", 3), null);
  assert.equal(commandQuery("/remind 2h", 7), "remind");
  // Arguments started: the list closes.
  assert.equal(commandQuery("/remind ", 8), null);
  assert.equal(commandQuery("hello /re", 9), null);
  assert.equal(commandQuery(" /re", 4), null);
});

test("the unknown-command line says nothing was sent", () => {
  assert.equal(
    unknownCommandMessage("remnid"),
    "Unknown command /remnid — not sent. Start with a space to send it as text.",
  );
  assert.equal(
    unknownCommandMessage(""),
    "Type a command after / — nothing was sent.",
  );
});
