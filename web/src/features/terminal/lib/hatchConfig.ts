/**
 * Where crichton's hatch service lives (phase-7.md §7, "Web config").
 *
 * `VITE_HATCH_URL` is the build default (prod: the :6881 front door). A
 * per-browser override in localStorage wins, the same shape as the Files URL
 * (`buzz:files-url`): it lets a dev preview or an e2e point at another hatch
 * without a rebuild. Nothing in the UI writes it.
 *
 * Unset in both places means NO Terminal nav row and NO crichton Vitals rows
 * (plan §1: a control appears only when something can answer it). The prod
 * build bakes a default in, so the override also takes the literal `off`
 * (`HATCH_URL_OFF`) to reach that state on such a build — an e2e or a dev
 * preview that must show "no hatch" without rebuilding.
 */

const STORAGE_KEY = "buzz:hatch-url";

/** The override value that turns hatch off, build default included. */
export const HATCH_URL_OFF = "off";

/** The build-time default. Optional chaining: the node test runner has no `import.meta.env`. */
const BUILD_HATCH_URL: string = import.meta.env?.VITE_HATCH_URL ?? "";

/**
 * Normalize a configured value to an origin-rooted base with a trailing
 * slash, or null. Only http(s) — a `javascript:` or relative value is not a
 * service address.
 */
export function normalizeHatchUrl(
  raw: string | null | undefined,
): string | null {
  const value = raw?.trim();
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return null;
    }
    return `${url.origin}/`;
  } catch {
    return null;
  }
}

/**
 * Pure resolution: the override wins when set, else the build value. An
 * override of `off` wins too, as "no hatch".
 */
export function resolveHatchUrl(input: {
  env: string | null | undefined;
  stored: string | null | undefined;
}): string | null {
  if (input.stored?.trim().toLowerCase() === HATCH_URL_OFF) {
    return null;
  }
  return normalizeHatchUrl(input.stored) ?? normalizeHatchUrl(input.env);
}

function readStored(): string | null {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

/** The configured hatch base (`https://host:port/`), or null when unconfigured. */
export function hatchUrl(): string | null {
  return resolveHatchUrl({ env: BUILD_HATCH_URL, stored: readStored() });
}

/** The hatch origin, for checking `postMessage` senders. */
export function hatchOrigin(base: string): string {
  return new URL(base).origin;
}

/** `wss://host:port/ws/term?…` for an `https://host:port/` base. */
export function hatchWsUrl(base: string, query: URLSearchParams): string {
  const url = new URL("ws/term", base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.search = query.toString();
  return url.toString();
}
