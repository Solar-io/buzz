import { invokeTauri } from "./tauri";

/**
 * This machine's stable id (hostname, trimmed + lowercased by the Rust side).
 *
 * Used by the owner admin-command target gate (kind 24201) and the kind-30180
 * desktop-catalog publisher. The cache is machine-scoped, not
 * community-scoped — the hostname never changes across community switches, so
 * it deliberately does NOT need a `resetCommunityState()` entry.
 */
let cached: Promise<string> | null = null;

export function getMachineHostname(): Promise<string> {
  cached ??= invokeTauri<string>("machine_hostname")
    .then((host) => host.trim().toLowerCase())
    .catch(() => "");
  return cached;
}
