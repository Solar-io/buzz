import type { Profile } from "../hooks.ts";
import { authorLabel } from "../lib/authorLabel.ts";
import type { ThreadParticipants } from "../lib/threadSummary.ts";
import { AuthorAvatar } from "./AuthorAvatar.tsx";

/**
 * The desktop's overlapping, masked participant avatars
 * (`MessageThreadSummaryRow` → `ParticipantAvatar`).
 *
 * The mask is the detail that makes the overlap read as a stack rather than as
 * clipped circles: each avatar except the last punches a transparent disc
 * where its neighbour will sit, so the gap between them is the page behind,
 * not a ring drawn in some assumed background colour. That matters here
 * because the web theme is derived at runtime — a hardcoded ring would be
 * wrong in half the palettes.
 *
 * `AuthorAvatar` is used rather than `shared/ui/avatar` because relay profile
 * pictures are auth-gated: they need the signed GET that AuthorAvatar already
 * performs, and its identicon fallback is the same palette the timeline draws.
 */
export function ThreadParticipantStack({
  participants,
  profiles,
}: {
  participants: ThreadParticipants;
  profiles: Map<string, Profile>;
}) {
  if (participants.shown.length === 0) {
    return null;
  }
  const label =
    participants.total === 1
      ? "1 participant"
      : `${participants.total} participants`;
  return (
    // role="img" so the cluster reads as one labelled graphic rather than a
    // run of unlabelled initials: it is also the role that legitimately takes
    // an aria-label on a generic element.
    <span
      data-testid="thread-participants"
      role="img"
      aria-label={label}
      title={participants.shown
        .map((pubkey) => authorLabel(pubkey, profiles))
        .join(", ")}
      className="flex shrink-0 items-center"
    >
      {participants.shown.map((pubkey, index) => (
        <span
          key={pubkey}
          data-testid="thread-participant"
          className={index > 0 ? "-ml-1.5" : undefined}
          style={
            index < participants.shown.length - 1
              ? {
                  zIndex: index + 1,
                  mask: "radial-gradient(circle 12px at calc(100% + 5px) 50%, transparent 99%, #fff 100%)",
                  WebkitMask:
                    "radial-gradient(circle 12px at calc(100% + 5px) 50%, transparent 99%, #fff 100%)",
                }
              : { zIndex: index + 1 }
          }
        >
          <AuthorAvatar
            pubkey={pubkey}
            label={authorLabel(pubkey, profiles)}
            picture={profiles.get(pubkey)?.avatar}
            size="sm"
          />
        </span>
      ))}
      {participants.overflow > 0 ? (
        <span
          data-testid="thread-participant-overflow"
          className="-ml-1.5 flex h-5 items-center rounded-full bg-muted px-1.5 text-2xs font-medium text-muted-foreground"
        >
          +{participants.overflow}
        </span>
      ) : null}
    </span>
  );
}
