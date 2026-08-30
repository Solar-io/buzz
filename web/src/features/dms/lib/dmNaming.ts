/**
 * Display naming for DM channels. The relay names every DM channel "DM" in
 * its kind:39000 metadata and includes participant pubkeys as p tags
 * precisely so clients can derive a useful name client-side
 * (relay side_effects: "clients can resolve display names without a separate
 * kind:39002 fetch").
 */

import { truncatePubkey } from "../../../shared/lib/pubkey.ts";

export function shortKey(pubkey: string): string {
  return truncatePubkey(pubkey);
}

export interface NameLikeProfile {
  name: string;
  displayName?: string;
}

/**
 * Compose the sidebar/header name for a DM from its participants.
 *
 * - Self is excluded (a DM is named after the OTHER parties).
 * 1 participant → their name; 2 → "A & B"; 3+ → "A, B +N".
 * Falls back to a truncated key per participant when no profile is known.
 */
export function dmDisplayName(
  participants: string[],
  selfPubkey: string,
  profiles: Map<string, NameLikeProfile>,
): string {
  const others = participants.filter(
    (pubkey, index) =>
      pubkey !== selfPubkey && participants.indexOf(pubkey) === index,
  );
  if (others.length === 0) {
    return "Direct message";
  }
  const nameOf = (pubkey: string): string => {
    const profile = profiles.get(pubkey);
    // display_name first: several Buzz profiles (e.g. Sam's) set only that.
    return profile?.displayName || profile?.name || shortKey(pubkey);
  };
  if (others.length === 1) {
    return nameOf(others[0]);
  }
  if (others.length === 2) {
    return `${nameOf(others[0])} & ${nameOf(others[1])}`;
  }
  return `${nameOf(others[0])}, ${nameOf(others[1])} +${others.length - 2}`;
}
