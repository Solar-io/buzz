/** NIP-29 people roles. The relay remains the authority for every write. */
export type PeopleRole = "owner" | "admin" | "member" | "guest";
export const PEOPLE_ROLES: readonly PeopleRole[] = [
  "owner",
  "admin",
  "member",
  "guest",
];

/** Role changes MUST include member explicitly; omitting it preserves the old role. */
export function putUserTags(
  channelId: string,
  pubkey: string,
  role: PeopleRole,
): string[][] {
  return [
    ["h", channelId],
    ["p", key(pubkey)],
    ["role", role],
  ];
}

/** Channel-local removal (9001), independent of community restrictions. */
export function removeUserTags(channelId: string, pubkey: string): string[][] {
  return [
    ["h", channelId],
    ["p", key(pubkey)],
  ];
}

/** Mirrors desktop shared/api/moderation.ts: expiration is absolute Unix seconds, no h tag. */
export function timeoutTags(
  pubkey: string,
  seconds: number,
  reason: string,
  now = Math.floor(Date.now() / 1000),
): string[][] {
  if (!Number.isSafeInteger(seconds) || seconds <= 0)
    throw new Error("Choose a valid timeout duration.");
  return [
    ["p", key(pubkey)],
    ["expiration", String(now + seconds)],
    ["reason", requiredReason(reason)],
  ];
}

/** A permanent community ban (9040), with the moderator's audit reason. */
export function banTags(pubkey: string, reason: string): string[][] {
  return [
    ["p", key(pubkey)],
    ["reason", requiredReason(reason)],
  ];
}

function key(pubkey: string): string {
  const normalized = pubkey.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized))
    throw new Error("Choose a valid public key.");
  return normalized;
}

function requiredReason(reason: string): string {
  const trimmed = reason.trim();
  if (!trimmed) throw new Error("Enter a reason for the community action.");
  return trimmed;
}

/** A sole owner can neither be demoted nor removed, including by themselves. */
export function isLastOwner(
  member: { role?: string },
  members: readonly { role?: string }[],
): boolean {
  return (
    member.role === "owner" &&
    members.filter((item) => item.role === "owner").length <= 1
  );
}

/** Preserve the relay's p-tag role slot; short legacy tags confer no admin rights. */
export function channelMemberRole(tag: readonly string[]): string | undefined {
  return [...PEOPLE_ROLES, "bot"].includes(tag[3]) ? tag[3] : undefined;
}
