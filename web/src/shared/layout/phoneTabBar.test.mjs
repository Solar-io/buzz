import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activePhoneTab,
  lastPhoneTab,
  phoneTabBarVisible,
  rememberPhoneTab,
} from "./phoneTabs.ts";

test("tab bar hidden while a conversation is open", () => {
  // PhoneChannel shows no tab bar: the conversation owns the screen.
  assert.equal(
    phoneTabBarVisible({
      conversationOpen: true,
      view: undefined,
      webLayerActive: false,
    }),
    false,
  );
  // Tab pages show it: Work, Channels, and the views under More.
  for (const view of ["work", "channels", "inbox", "reminders"]) {
    assert.equal(
      phoneTabBarVisible({
        conversationOpen: false,
        view,
        webLayerActive: false,
      }),
      true,
      view,
    );
  }
  // A view over a remembered conversation id is still a tab page…
  assert.equal(
    phoneTabBarVisible({
      conversationOpen: true,
      view: "work",
      webLayerActive: false,
    }),
    true,
  );
  // …and Files / a link takes the screen like a conversation does.
  assert.equal(
    phoneTabBarVisible({
      conversationOpen: false,
      view: "work",
      webLayerActive: true,
    }),
    false,
  );
});

test("the tab derives from the URL and back returns to the last tab", () => {
  assert.equal(activePhoneTab("work"), "work");
  assert.equal(activePhoneTab("channels"), "channels");
  assert.equal(activePhoneTab(undefined), "channels");
  assert.equal(activePhoneTab("inbox"), "more");
  assert.equal(
    lastPhoneTab(),
    "channels",
    "Channels is home until a tab is visited",
  );
  rememberPhoneTab("work");
  assert.equal(lastPhoneTab(), "work");
  rememberPhoneTab("channels");
  assert.equal(lastPhoneTab(), "channels");
  rememberPhoneTab("more");
  assert.equal(lastPhoneTab(), "channels", "More is a sheet, not a place");
  rememberPhoneTab("work");
  assert.equal(lastPhoneTab(), "work");
});
