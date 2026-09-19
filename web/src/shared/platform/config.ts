/** Public service addresses only. Never credentials or an identity secret. */
export interface NativeServices {
  relayUrl: string;
  sttUrl: string;
  ttsUrl: string;
  pushGatewayUrl: string;
}
const KEY = "buzz.native-services.v1";

export function validateServices(input: NativeServices): NativeServices {
  for (const [name, value] of Object.entries(input)) {
    if (!value && name !== "relayUrl") continue;

    // Cap length
    if (value.length > 512) {
      throw new Error(`${name} exceeds 512 character limit.`);
    }

    // Reject @ (credentials)
    if (value.includes("@")) {
      throw new Error(
        `${name} must not contain credentials (@ character not allowed).`,
      );
    }

    const url = new URL(value);
    const scheme = name === "relayUrl" || name === "sttUrl" ? "wss:" : "https:";

    if (
      url.protocol !== scheme ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.hash ||
      url.search
    ) {
      throw new Error(
        `${name} must be a secure URL without credentials, a query or a fragment.`,
      );
    }

    // No path on relayUrl or pushGatewayUrl
    if (
      (name === "relayUrl" || name === "pushGatewayUrl") &&
      url.pathname !== "" &&
      url.pathname !== "/"
    ) {
      throw new Error(`${name} must not have a path component.`);
    }
  }
  return input;
}
export function readNativeServices(): NativeServices | null {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.relayUrl !== "string") return null;
    return validateServices({
      relayUrl: parsed.relayUrl,
      sttUrl: parsed.sttUrl ?? "",
      ttsUrl: parsed.ttsUrl ?? "",
      pushGatewayUrl: parsed.pushGatewayUrl ?? "",
    });
  } catch {
    return null;
  }
}
export function writeNativeServices(input: NativeServices): void {
  globalThis.localStorage.setItem(KEY, JSON.stringify(validateServices(input)));
}
