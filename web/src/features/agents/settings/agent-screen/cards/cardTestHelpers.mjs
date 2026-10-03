import { JSDOM } from "jsdom";
export const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://web.test",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
export const { createElement: h, act } = await import("react");
const { createRoot } = await import("react-dom/client");
export async function mount(Component, props, run) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(() => root.render(h(Component, props)));
    await run(container);
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
}
export function selectFor(container, label) {
  const lab = [...container.querySelectorAll("label")].find(
    (el) => el.textContent === label,
  );
  return container.ownerDocument.getElementById(lab.htmlFor);
}
export async function change(control, value) {
  await act(() => {
    control.value = value;
    control.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
}
export const row = {
  pubkey: "a".repeat(64),
  name: "Test agent",
  model: "old-model",
  provider: "openrouter",
  persona: null,
  personaLinked: false,
  machines: ["crichton.local"],
  entry: {
    pubkey: "a".repeat(64),
    name: "Test agent",
    model: "old-model",
    provider: "openrouter",
    systemPrompt: "",
    personaId: null,
    parallelism: 2,
    respondTo: "owner-only",
    respondToAllowlist: [],
    updatedAt: 1,
    effort: { acp: "medium" },
  },
};
export function fields(values = {}, edit = () => {}) {
  const base = {
    model: "old-model",
    provider: "openrouter",
    harness: "__unreported",
    parallelism: 2,
    idleTimeoutSeconds: null,
    maxTurnDurationSeconds: null,
    startOnAppLaunch: "__unreported",
    respondTo: "owner-only",
    respondToAllowlist: "[]",
    ...values,
  };
  return {
    value: (field) => base[field],
    edit,
    dirty: () => false,
    disabled: false,
    controlsLocked: false,
    machine: "crichton.local",
  };
}
