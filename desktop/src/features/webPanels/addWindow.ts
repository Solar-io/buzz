import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Entry for the trusted add-site window's bundled form (add.html → this
 * module; a first-class vite input, NOT the main SPA). The window is
 * created Rust-side by `open_web_panel_add_window` with the label
 * "webpanel-add", and THAT label is the security gate: `add_custom_panel`
 * honors a URL only from this webview — a compromised main app webview can
 * invoke the command but is refused before any validation runs.
 *
 * Add → invoke `add_custom_panel {label, url}`; the command's error
 * (duplicate / cap / invalid URL) renders inline so the owner can fix the
 * input; success closes the window (Rust broadcasts a
 * `custom-panel-added` event so the app refreshes its registry). Cancel
 * just closes.
 */

const form = document.querySelector<HTMLFormElement>("#buzz-add-form");
const labelInput = document.querySelector<HTMLInputElement>("#buzz-add-label");
const urlInput = document.querySelector<HTMLInputElement>("#buzz-add-url");
const errorOutput = document.querySelector<HTMLParagraphElement>(
  "#buzz-add-error",
);
const cancelButton = document.querySelector<HTMLButtonElement>(
  "#buzz-add-cancel",
);
const submitButton = document.querySelector<HTMLButtonElement>(
  "#buzz-add-submit",
);

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function closeWindow(): void {
  // The capability grants core:window:allow-close to "webpanel-add".
  getCurrentWindow().close().catch((error: unknown) => {
    console.error("cannot close the add-site window", error);
  });
}

if (
  form &&
  labelInput &&
  urlInput &&
  errorOutput &&
  cancelButton &&
  submitButton
) {
  form.addEventListener("submit", (event) => {
    // CSP pins form-action 'none'; this keeps Enter-to-submit local.
    event.preventDefault();
    errorOutput.textContent = "";
    submitButton.disabled = true;
    invoke("add_custom_panel", {
      label: labelInput.value,
      url: urlInput.value,
    })
      .then(closeWindow)
      .catch((error: unknown) => {
        // Duplicate / cap / invalid URL — surface the command's message
        // inline and let the owner fix the input and retry.
        errorOutput.textContent = describeError(error);
        submitButton.disabled = false;
      });
  });
  cancelButton.addEventListener("click", closeWindow);
} else {
  console.error("the add-site form is missing its controls");
}
