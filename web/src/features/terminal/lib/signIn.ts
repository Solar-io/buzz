/**
 * Signing in to crichton from Buzz (phase-7.md §6.3, W-8).
 *
 * hatch's session is its own Supabase + GitHub PKCE flow. GitHub refuses
 * iframes and the PKCE cookie needs a top-level return, so the page opens
 * `/auth/github?redirectTo=/auth/signed-in` as a top-level window. hatch's
 * `/auth/signed-in` posts `{type: "hatch:signed-in"}` to its opener — at each
 * allowlisted Buzz origin only — and closes. The page then re-checks
 * `/api/me`. No token ever appears in a URL or a message.
 *
 * GitHub's pages may sever `window.opener` (COOP), so the message is a fast
 * path, not the only one: the page also re-checks on focus and visibility.
 */

export const SIGNED_IN_MESSAGE = "hatch:signed-in";

/** The sign-in URL: path-only `redirectTo` (hatch refuses absolute ones). */
export function signInUrl(base: string): string {
  const url = new URL("auth/github", base);
  url.searchParams.set("redirectTo", "/auth/signed-in");
  return url.toString();
}

/**
 * A `message` listener that calls `onSignedIn` ONLY for hatch's own message
 * from hatch's own origin. Any other window can post anything to us; the
 * origin check is what makes "re-check the session" the only effect.
 */
export function createSignInListener(
  hatchOrigin: string,
  onSignedIn: () => void,
): (event: { origin: string; data: unknown }) => void {
  return (event) => {
    if (event.origin !== hatchOrigin) {
      return;
    }
    const data = event.data;
    if (
      typeof data === "object" &&
      data !== null &&
      (data as { type?: unknown }).type === SIGNED_IN_MESSAGE
    ) {
      onSignedIn();
    }
  };
}
