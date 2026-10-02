import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://web.test",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createElement: h, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useSettingsDraft } = await import("./useSettingsDraft.ts");
after(() => dom.window.close());
const entry = (key = "a", inherited = false) => ({
  agentPubkey: key,
  agentName: key,
  machine: "crichton",
  field: "model",
  label: "Model",
  original: { value: "old", inherited },
  clearValue: null,
  defaultLabel: "global",
  takesEffect: "restart-when-idle",
  change: { kind: "set", value: "new" },
});
async function fixture(send, run) {
  let draft;
  function Screen() {
    draft = useSettingsDraft(send);
    return null;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(() => root.render(h(Screen)));
    await run(() => draft);
  } finally {
    await act(() => root.unmount());
  }
}
test("draft is Sending until desktop ack; duplicate saves and edits during save are ignored", async () => {
  let answer;
  let calls = 0;
  await fixture(
    () => {
      calls++;
      return new Promise((resolve) => {
        answer = resolve;
      });
    },
    async (draft) => {
      await act(() => draft().edit(entry()));
      let pending;
      await act(async () => {
        pending = draft().save();
        draft().save();
        await Promise.resolve();
      });
      assert.equal(draft().state.status, "sending");
      assert.equal(draft().dirty, true);
      assert.equal(calls, 1);
      await act(() => {
        draft().edit(entry("b"));
        draft().discard();
      });
      assert.equal(draft().draft.size, 1);
      await act(async () => {
        answer({ ok: true });
        await pending;
      });
      assert.equal(draft().state.status, "saved");
      assert.equal(draft().dirty, false);
      assert.equal(draft().canUndo, true);
      assert.equal(
        draft().changes.length,
        1,
        "saved receipt keeps its change list",
      );
    },
  );
});
test("refused ack retains only failed agent edits and retry does not resend successes", async () => {
  const calls = [];
  let refuse = true;
  await fixture(
    async (plan) => {
      calls.push(plan.request.pubkey);
      return plan.request.pubkey === "b" && refuse
        ? { ok: false, error: "bad model" }
        : { ok: true };
    },
    async (draft) => {
      await act(() => {
        draft().edit(entry());
        draft().edit(entry("b"));
      });
      await act(() => draft().save());
      assert.equal(draft().state.status, "error");
      assert.equal(draft().draft.size, 1);
      assert.equal([...draft().draft.values()][0].agentPubkey, "b");
      assert.equal(draft().state.errors[0].error, "bad model");
      refuse = false;
      await act(() => draft().save());
      assert.deepEqual(calls, ["a", "b", "b"]);
      assert.equal(draft().state.status, "saved");
      assert.equal(
        draft().changes.length,
        2,
        "receipt includes successes from the original partial batch",
      );
    },
  );
});
test("Undo sends the acknowledged inverse and waits for its own desktop ack", async () => {
  const requests = [];
  await fixture(
    async (plan) => {
      requests.push(plan.request);
      return { ok: true };
    },
    async (draft) => {
      await act(() => draft().edit(entry("a", true)));
      await act(() => draft().save());
      await act(() => draft().undo());
      assert.deepEqual(requests, [
        { pubkey: "a", model: "new" },
        { pubkey: "a", model: null },
      ]);
      assert.equal(draft().state.status, "saved");
      assert.equal(draft().canUndo, false);
    },
  );
});
