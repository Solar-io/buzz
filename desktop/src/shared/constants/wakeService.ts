/**
 * Identities whose kind-9 posts that p-tag a member are scheduled wakes
 * (buzz-services reminder firings, signed as BUZZ_SERVICES_KEY).
 *
 * Mirrors `WAKE_SERVICE_PUBKEYS` in `web/src/features/channels/lib/
 * wakeMessage.ts` and `WAKE_SERVICE_PUBKEYS` in
 * `src-tauri/src/unread_catch_up.rs` — the three must name the same keys.
 * Overridable with VITE_WAKE_SERVICE_PUBKEYS (comma-separated), like web.
 *
 * CHANGE TOGETHER: `WAKE_SERVICE_PUBKEYS` in
 * `desktop/src-tauri/src/unread_catch_up.rs` is the unread CATCH-UP copy of
 * this list. It is a compile-time constant and does NOT read the env
 * override, so an override set here makes live notifications and catch-up
 * disagree about what a wake is. Edit the default in both files;
 * `wakeService.test.mjs` fails when the two defaults differ.
 */
const DEFAULT_WAKE_SERVICE_PUBKEYS = [
  "a9387088355b4efe46decbde77c8fe34ee9ecbd6619d41217d21be0123f08271",
];

function resolveWakeServicePubkeys(): string[] {
  // The typeof guard keeps the module importable under the node test runner,
  // where vite never injects `env`.
  const raw =
    typeof import.meta.env === "undefined"
      ? undefined
      : (import.meta.env.VITE_WAKE_SERVICE_PUBKEYS as string | undefined);
  if (!raw) return DEFAULT_WAKE_SERVICE_PUBKEYS;
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export const WAKE_SERVICE_PUBKEYS: string[] = resolveWakeServicePubkeys();
