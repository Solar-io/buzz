import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://web.test/",
});
for (const name of [
  "window",
  "document",
  "HTMLElement",
  "Element",
  "SVGElement",
  "HTMLInputElement",
  "HTMLSelectElement",
  "HTMLTextAreaElement",
  "Node",
  "NodeFilter",
  "Event",
  "CustomEvent",
  "FocusEvent",
  "MouseEvent",
  "KeyboardEvent",
  "MutationObserver",
  "getComputedStyle",
])
  globalThis[name] = dom.window[name];
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  "@/shared/api/RelaySessionProvider": `export function useRelaySession() { return {session: globalThis.w2Session}; }`,
  "@/shared/lib/nostr-signer": `export async function ownPubkey() {return null;} export async function nip44EncryptTo(value) {return {ciphertext:value};} export async function nip44DecryptFrom(value) {return {plaintext:value};} export async function signNostrEvent(event) { return {...event, id:'signed', pubkey:'self', created_at:1, sig:'sig'}; }`,
  "@tanstack/react-router": `export function useNavigate() {return async () => {};}`,
  "@/shared/theme/ThemeProvider": `export function useTheme() { return {isDark: true}; }`,
  "@/features/agents/useAgentRegistry": `export function useAgentRegistry() { return []; }`,
  "@/shared/lib/localSeed.ts": `export async function loadSeed() { return null; } export function mergeSeed() {}`,
};
const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MembersTab } = await import("./MembersTab.tsx");
const SELF = "a".repeat(64),
  PERSON = "b".repeat(64),
  NEW = "c".repeat(64),
  PEER = "d".repeat(64);
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const roster = (roles, clock = 1) => ({
  id: `roster-${clock}`,
  kind: 39002,
  created_at: clock,
  tags: [
    ["d", "w2"],
    ["h", "w2"],
    ...roles.map(([pk, role]) => ["p", pk, "", role]),
  ],
  content: "",
});

async function mount({
  myRole = "owner",
  communityRole = "member",
  targetRole = "member",
  archived = false,
  secondOwner = false,
} = {}) {
  const subscriptions = new Set();
  const roles = [
    [SELF, myRole],
    [PERSON, "guest"],
    ...(secondOwner ? [[PEER, "owner"]] : []),
  ];
  const events = [
    roster(roles),
    {
      kind: 13534,
      created_at: 1,
      tags: [
        ["member", SELF, communityRole],
        ["member", PERSON, targetRole],
        ["member", NEW, "member"],
      ],
    },
    ...[
      [SELF, "Sam"],
      [PERSON, "Alex"],
      [NEW, "Taylor"],
    ].map(([pubkey, name]) => ({
      id: pubkey,
      kind: 0,
      pubkey,
      created_at: 1,
      content: JSON.stringify({ display_name: name }),
      tags: [],
    })),
  ];
  const matches = (filter, event) =>
    filter.kinds?.includes(event.kind) &&
    (!filter.authors || filter.authors.includes(event.pubkey)) &&
    (!filter["#d"] ||
      event.tags.some(
        (tag) => tag[0] === "d" && filter["#d"].includes(tag[1]),
      ));
  const published = [];
  const session = {
    subscribe(filter, handlers) {
      const entry = { filter, handlers };
      subscriptions.add(entry);
      queueMicrotask(() => {
        if (subscriptions.has(entry)) {
          for (const event of events.filter((event) => matches(filter, event)))
            handlers.onEvent?.(event);
          handlers.onEose?.();
        }
      });
      return () => subscriptions.delete(entry);
    },
    async publish(event) {
      published.push(event);
      return { ok: true, message: "" };
    },
  };
  globalThis.w2Session = session;
  window.confirm = () => true;
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const echo = async (event) =>
    act(async () => {
      for (const { filter, handlers } of [...subscriptions])
        if (matches(filter, event)) handlers.onEvent?.(event);
      await tick();
    });
  await act(async () => {
    root.render(
      React.createElement(MembersTab, {
        channelId: "w2",
        selfPubkey: SELF,
        agentPubkeys: new Set(),
        archived,
      }),
    );
    await tick();
  });
  await act(tick);
  return {
    node,
    published,
    session,
    roles,
    echo,
    close: async () => {
      await act(async () => root.unmount());
      node.remove();
      assert.equal(
        subscriptions.size,
        0,
        "real hooks release all subscriptions",
      );
    },
  };
}
const byLabel = (label) => document.querySelector(`[aria-label="${label}"]`);
const button = (text) =>
  [...document.querySelectorAll("button")].find(
    (node) => node.textContent.trim() === text,
  );
async function change(node, value) {
  await act(async () => {
    const proto =
      node.tagName === "TEXTAREA"
        ? HTMLTextAreaElement.prototype
        : node.tagName === "SELECT"
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(node, value);
    node.dispatchEvent(
      new Event(node.tagName === "SELECT" ? "change" : "input", {
        bubbles: true,
      }),
    );
    await tick();
  });
}
async function menu(label) {
  await act(async () => {
    byLabel(`More for ${label}`).dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await tick();
  });
}
const menuItem = (text) =>
  [...document.querySelectorAll('[role="menuitem"]')].find((node) =>
    node.textContent.includes(text),
  );

test("role change publishes 9000 with the new role and the row updates from the next 39002", async () => {
  const view = await mount();
  try {
    assert.equal(byLabel("Role for Alex").value, "guest");
    await change(byLabel("Role for Alex"), "member");
    assert.equal(view.published.length, 1);
    assert.equal(view.published[0].kind, 9000);
    assert.deepEqual(view.published[0].tags, [
      ["h", "w2"],
      ["p", PERSON],
      ["role", "member"],
    ]);
    assert.equal(
      byLabel("Role for Alex").value,
      "guest",
      "ack alone cannot invent a new role",
    );
    await view.echo(
      roster(
        [
          [SELF, "owner"],
          [PERSON, "member"],
        ],
        2,
      ),
    );
    assert.equal(byLabel("Role for Alex").value, "member");
  } finally {
    await view.close();
  }
});
test("remove publishes 9001 and the row disappears only on the replacement roster", async () => {
  const view = await mount();
  try {
    await menu("Alex");
    await act(async () => {
      menuItem("Remove from channel").click();
      await tick();
    });
    assert.equal(view.published.length, 1);
    assert.equal(view.published[0].kind, 9001);
    assert.deepEqual(view.published[0].tags, [
      ["h", "w2"],
      ["p", PERSON],
    ]);
    assert.ok(document.querySelector(`[data-testid="member-row-${PERSON}"]`));
    await view.echo(roster([[SELF, "owner"]], 2));
    assert.equal(
      document.querySelector(`[data-testid="member-row-${PERSON}"]`),
      null,
    );
  } finally {
    await view.close();
  }
});
test("non-admin sees no role dropdown and no moderation items", async () => {
  const view = await mount({ myRole: "member" });
  try {
    assert.equal(document.querySelectorAll("select").length, 0);
    assert.equal(byLabel("More for Alex"), null);
    assert.equal(view.published.length, 0);
  } finally {
    await view.close();
  }
});
test("last owner demote is disabled", async () => {
  const view = await mount();
  try {
    assert.equal(byLabel("Role for Sam").disabled, true);
    assert.equal(byLabel("Role for Sam").title, "A channel needs an owner");
    assert.equal(
      document.getElementById(`owner-reason-${SELF}`).textContent,
      "A channel needs an owner",
    );
    await menu("Sam");
    assert.equal(
      menuItem("Remove from channel").getAttribute("aria-disabled"),
      "true",
    );
  } finally {
    await view.close();
  }
});
test("a second owner permits a role change", async () => {
  const view = await mount({ secondOwner: true });
  try {
    assert.equal(byLabel("Role for Sam").disabled, false);
    await change(byLabel("Role for Sam"), "admin");
    assert.equal(view.published.length, 1);
  } finally {
    await view.close();
  }
});
test("channel admin cannot moderate but a community admin can", async () => {
  for (const communityRole of ["member", "admin"]) {
    const view = await mount({ myRole: "admin", communityRole });
    try {
      await menu("Alex");
      assert.equal(
        Boolean(menuItem("Ban from community")),
        communityRole === "admin",
      );
      assert.equal(
        Boolean(menuItem("Time out from community")),
        communityRole === "admin",
      );
    } finally {
      await view.close();
    }
  }
});
test("community admin cannot restrict a community owner or fellow admin", async () => {
  for (const targetRole of ["owner", "admin"]) {
    const view = await mount({ communityRole: "admin", targetRole });
    try {
      await menu("Alex");
      assert.equal(menuItem("Ban from community"), undefined);
    } finally {
      await view.close();
    }
  }
});
test("timeout requires a reason and publishes community-scoped 9042", async () => {
  const view = await mount({ communityRole: "owner" });
  try {
    await menu("Alex");
    await act(async () => {
      menuItem("Time out from community").click();
      await tick();
    });
    assert.equal(button("Time out from community").disabled, true);
    await change(byLabel("Reason"), "Repeated spam");
    await change(byLabel("Timeout duration"), "3600");
    const before = Math.floor(Date.now() / 1000);
    await act(async () => {
      button("Time out from community").click();
      await tick();
    });
    assert.equal(view.published.length, 1);
    assert.equal(view.published[0].kind, 9042);
    const tags = view.published[0].tags;
    assert.deepEqual(
      tags.filter((tag) => tag[0] !== "expiration"),
      [
        ["p", PERSON],
        ["reason", "Repeated spam"],
      ],
    );
    assert.ok(
      Number(tags.find((tag) => tag[0] === "expiration")[1]) >= before + 3600,
    );
  } finally {
    await view.close();
  }
});
test("refused role change stays visible and preserves the roster", async () => {
  const view = await mount();
  try {
    view.session.publish = async () => ({
      ok: false,
      message: "Only an admin can change roles",
    });
    await change(byLabel("Role for Alex"), "member");
    assert.equal(
      document.querySelector('[role="alert"]').textContent,
      "Only an admin can change roles",
    );
    assert.equal(byLabel("Role for Alex").value, "guest");
  } finally {
    await view.close();
  }
});
test("archived channels disable membership writes", async () => {
  const view = await mount({ archived: true, communityRole: "owner" });
  try {
    assert.equal(button("People").disabled, true);
    assert.equal(byLabel("Role for Alex").disabled, true);
    assert.equal(byLabel("More for Alex").disabled, true);
  } finally {
    await view.close();
  }
});
test("Add people sends the per-invitee Guest role", async () => {
  const view = await mount();
  try {
    await act(async () => {
      button("People").click();
      await tick();
    });
    await act(async () => {
      byLabel("Select Taylor").click();
      await tick();
    });
    await change(byLabel("Invite role for Taylor"), "guest");
    await act(async () => {
      button("Add people").click();
      await tick();
    });
    assert.equal(view.published.length, 1);
    assert.deepEqual(view.published[0].tags, [
      ["h", "w2"],
      ["p", NEW],
      ["role", "guest"],
    ]);
  } finally {
    await view.close();
  }
});

after(() => dom.window.close());
