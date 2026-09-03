/**
 * Plain-language respond-to field model, shared by the create and edit
 * forms. Deliberate web mirror of the desktop's shared respond-to contract
 * (desktop/src/features/agents/lib/agentAccessWarning.ts +
 * ui/respondToFieldContract.test.mjs): mode labels never leak protocol
 * jargon, and both sharing modes show the access warning — only the audience
 * phrase differs. The web cannot know a run location (no backend read), and
 * the desktop's own rule is that unknown reads as LOCAL wording — never
 * hedge with "computer or server".
 */

export type RespondToMode = "owner-only" | "anyone" | "allowlist";

/** Dropdown options — labels are plain language, values ride the protocol. */
export const RESPOND_TO_OPTIONS: readonly {
  value: RespondToMode;
  label: string;
}[] = [
  { value: "owner-only", label: "Only me (owner)" },
  { value: "anyone", label: "Anyone" },
  { value: "allowlist", label: "Specific people" },
];

/**
 * The access-warning sentence for a sharing mode, or null for owner-only.
 * Both strings are pinned byte-for-byte against the desktop's
 * agentAccessWarningText with a local run location (plan §0); a drift in
 * either breaks respondToField.test.mjs.
 */
export function accessWarning(mode: RespondToMode): string | null {
  if (mode === "anyone") {
    return "Anyone can use this agent to access your computer, including files, accounts, and connected tools.";
  }
  if (mode === "allowlist") {
    return "Selected people can use this agent to access your computer, including files, accounts, and connected tools.";
  }
  return null;
}

const PUBKEY_RE = /^[0-9a-f]{64}$/;

/**
 * Validate an allowlist for the `allowlist` mode: at least one entry, every
 * entry a 64-hex agent key. Returns the error string or null when valid.
 */
export function validateAllowlist(list: readonly string[]): string | null {
  const entries = list.map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) {
    return "Specific people requires at least one key.";
  }
  if (entries.some((entry) => !PUBKEY_RE.test(entry))) {
    return "Allowlist entries must be agent keys — copy them from the desktop or a profile.";
  }
  return null;
}
