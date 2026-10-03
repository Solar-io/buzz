import { JSDOM } from "jsdom";

export const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://web.test",
});
for (const key of [
  "window",
  "document",
  "HTMLElement",
  "Element",
  "Node",
  "CustomEvent",
  "MutationObserver",
  "DocumentFragment",
  "HTMLInputElement",
  "HTMLTextAreaElement",
]) {
  globalThis[key] =
    key === "window"
      ? dom.window
      : key === "document"
        ? dom.window.document
        : dom.window[key];
}
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
globalThis.cancelAnimationFrame = clearTimeout;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.__W11A_IMPORT__ = () => {};
globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  "./ui/SettingsNavGuard":
    "export function SettingsNavGuard() { return null; }",
  "./SnapshotPreviewProvider":
    "export function useSnapshotFileImport() { return globalThis.__W11A_IMPORT__; }",
  sonner: "export const toast = { success() {}, error() {} };",
};
export const { createElement: h, act } = await import("react");
const { createRoot } = await import("react-dom/client");

export async function mount(Component, props, run) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async (next = props) => {
    props = next;
    await act(async () => root.render(h(Component, props)));
  };
  try {
    await render();
    await run(container, render);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
}
export async function fill(container, label, value) {
  const control = container.querySelector(`[aria-label="${label}"]`);
  if (!control) throw new Error(`Missing ${label}`);
  const prototype =
    control.tagName === "TEXTAREA"
      ? dom.window.HTMLTextAreaElement.prototype
      : dom.window.HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(
      control,
      value,
    );
    control.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}
export async function choose(container, label, value) {
  const labelEl = Array.from(container.querySelectorAll("label")).find(
    (el) => el.textContent === label,
  );
  const control =
    container.querySelector(`[aria-label="${label}"]`) ??
    document.getElementById(labelEl?.htmlFor);
  if (!control) throw new Error(`Missing ${label}`);
  await act(async () => {
    control.value = value;
    control.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
}
export function button(container, name) {
  const result = Array.from(container.querySelectorAll("button")).find(
    (el) => el.textContent === name,
  );
  if (!result) throw new Error(`Missing button ${name}`);
  return result;
}
