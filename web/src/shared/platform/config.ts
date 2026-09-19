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
