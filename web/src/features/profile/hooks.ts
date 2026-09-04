import { useEffect, useState } from "react";
import type { RelaySession } from "@/shared/api/relay-session";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import { signNostrEvent } from "@/shared/lib/nostr-signer";
import {
  EMPTY_PROFILE_METADATA,
  parseProfileContent,
  pickLatestProfileEvent,
  serializeProfileContent,
  type ProfileDraft,
  type ProfileMetadata,
} from "./lib/kind0.ts";

/**
 * Kind-0 access for the profile surfaces.
 *
 * `features/channels/hooks.ts` already has a `useProfiles(pubkeys)` for the
 * timeline, and this deliberately does not replace it: that one is a
 * many-author, first-seen, localStorage-seeded cache tuned for painting
 * hundreds of rows on the first frame, and it reads only name/display_name/
 * picture. The profile card needs the *rest* of the kind-0 payload (`about`,
 * `nip05`, `website`), needs latest-wins rather than first-seen because the
 * edit form republishes what it reads, and needs the raw content string so a
 * publish can preserve fields this client does not model.
 *
 * It is single-author and mounted only while a card is open, so the extra
 * subscription costs one REQ per opened popover.
 */

export interface ProfileMetadataState {
  metadata: ProfileMetadata;
  /** Verbatim content of the newest kind-0 seen — the publish baseline. */
  rawContent: string | null;
  /** `created_at` of that event, or null when none has arrived. */
  createdAt: number | null;
  /** True until the first event or the relay's EOSE. */
  loading: boolean;
}

const EMPTY_STATE: ProfileMetadataState = {
  metadata: EMPTY_PROFILE_METADATA,
  rawContent: null,
  createdAt: null,
  loading: false,
};

/**
 * Live kind-0 metadata for one author. Pass null to subscribe to nothing.
 */
export function useProfileMetadata(
  pubkey: string | null,
): ProfileMetadataState {
  const { session } = useRelaySession();
  const [state, setState] = useState<ProfileMetadataState>(EMPTY_STATE);

  useEffect(() => {
    if (!pubkey) {
      setState(EMPTY_STATE);
      return;
    }
    // A new author starts from scratch: keeping the previous author's bio on
    // screen while the next one loads is how a card shows the wrong person.
    setState({ ...EMPTY_STATE, loading: true });
    let newest: SignedNostrEvent | null = null;
    return session.subscribe(
      { kinds: [0], authors: [pubkey], limit: 1 },
      {
        onEvent: (event: SignedNostrEvent) => {
          const previous = newest;
          newest = pickLatestProfileEvent(previous, event);
          if (previous && newest === previous) {
            // An older echo: the newer event already on screen wins.
            return;
          }
          const winner = newest;
          setState({
            metadata: parseProfileContent(winner.content),
            rawContent: winner.content,
            createdAt: winner.created_at,
            loading: false,
          });
        },
        onEose: () => {
          setState((current) =>
            current.loading ? { ...current, loading: false } : current,
          );
        },
      },
    );
  }, [session, pubkey]);

  return state;
}

export interface PublishProfileResult {
  ok: boolean;
  message: string;
}

/**
 * Publish the viewer's own kind-0.
 *
 * Same sign-then-publish shape as `sendChannelMessage`: build the template,
 * `signNostrEvent`, hand the signed event to the session. The content is
 * merged onto `previousContent` (see `serializeProfileContent`) so a publish
 * from this small form cannot delete metadata another client wrote.
 */
export async function publishProfileMetadata(
  session: RelaySession,
  options: { draft: ProfileDraft; previousContent: string | null },
): Promise<PublishProfileResult> {
  const event = await signNostrEvent({
    kind: 0,
    tags: [],
    content: serializeProfileContent(options.draft, options.previousContent),
  });
  const result = await session.publish(event);
  return { ok: result.ok, message: result.message };
}
