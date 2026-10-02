import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * The phone tab bar as RENDERED (Sam, 2026-10-01): Channels on the left,
 * Work in the middle, More last — and each badge stays on its own tab while
 * the tabs move. phoneTabBar.test.mjs covers the routing policy (on a
 * case-insensitive disk `PhoneTabBar.test.mjs` IS that file, hence this
 * name); this drives the real component, because the order is a fact about
 * its markup and nothing else.
 *
 * The two counts are deliberately different numbers, so a badge that
 * followed the wrong tab cannot pass by coincidence.
 */
const { JSDOM } = await import("jsdom");
const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { PhoneTabBar } = await import("./PhoneTabBar.tsx");

const NEEDS = 3;
const UNREAD = 7;

function renderBar(active) {
  const html = renderToStaticMarkup(
    createElement(PhoneTabBar, {
      active,
      needs: NEEDS,
      unread: UNREAD,
      onWork: () => {},
      onChannels: () => {},
      more: [],
    }),
  );
  const { document } = new JSDOM(`<body>${html}</body>`).window;
  const bar = document.querySelector('[data-testid="phone-tab-bar"]');
  assert.ok(bar, "the tab bar renders");
  return [...bar.querySelectorAll(":scope > button")];
}

/** The tab's label: its text with the badge's digits taken off. */
function label(button) {
  const badge = button.querySelector("span");
  const text = button.textContent ?? "";
  return badge ? text.replace(badge.textContent ?? "", "") : text;
}

test("left to right: Channels, Work, More", () => {
  const tabs = renderBar("channels");
  assert.deepEqual(tabs.map(label), ["Channels", "Work", "More"]);
});

test("each badge rides its own tab: unread on Channels, needs-you on Work", () => {
  const [channels, work, more] = renderBar("work");
  const channelsBadge = channels.querySelector("span");
  const workBadge = work.querySelector("span");
  assert.equal(channelsBadge?.textContent, "7");
  assert.match(channelsBadge?.className ?? "", /\bbg-primary\b/);
  assert.equal(workBadge?.textContent, "3");
  assert.match(workBadge?.className ?? "", /\bbg-need\b/);
  assert.equal(more.querySelector("span"), null, "More carries no badge");
});

test("the active tab is marked wherever it sits", () => {
  for (const [active, index] of [
    ["channels", 0],
    ["work", 1],
    ["more", 2],
  ]) {
    const tabs = renderBar(active);
    assert.deepEqual(
      tabs.map((tab) => tab.getAttribute("aria-current")),
      [0, 1, 2].map((i) => (i === index ? "page" : null)),
      active,
    );
  }
});
