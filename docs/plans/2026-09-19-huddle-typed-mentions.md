# Huddle typed mentions

## Failure and intended behavior

A member added after an ephemeral channel composer mounts can appear in the
timeline while remaining absent from its mention candidates. A complete typed
display name then publishes without a recipient tag. The September 19 browser
reproduction used bundle `index-CIm4Dein.js`; relay event
`ef5cfa73ee0ecfc1faa7c98ed3cd6454581601219935a8c0e00b1f30f0224eac`
has an `h` tag but no `p` tag despite naming an admitted member.

Both the channel route and floating huddle chat must resolve mentions from the
current room roster. A typed full display name, selected suggestion, or valid
member `nostr:npub` URI must produce the intended recipient tag. An unresolved
mention must preserve the draft and explain the problem before publication.
Plain unaddressed chat remains valid.

## Design

- Reuse `useHuddleMemberSnapshot`: the relay stores replacement `39002`
  membership snapshots in a channel scope, while a `#d` subscription is global
  and does not receive later replacements. Re-requesting the snapshot is the
  existing measured solution.
- The call owns its roster from target selection. Floating chat consumes that
  roster. A selected temporary room without a known matching call roster uses
  its own snapshot request; it hands over to the call when that roster is
  known, avoiding duplicate polling in steady state.
- Load profiles for message authors and every roster member. A member need
  not speak before their display name becomes mentionable.
- Scope strict refusal to temporary-room composers, including their thread
  replies. Normal permanent-channel behavior remains compatible.
- Decode explicit public-key URIs outside code regions using the existing
  key parser, intersect with membership, and deduplicate with name mentions.
  Profiles and stale picker choices do not grant membership.
- `@Trevor` is a search query, not an abbreviation for `Trevor Lefkowitz`.
  Choose its suggestion or type the full name.

External roster changes retain the existing 15-second refresh interval.
Locally accepted adds can use the call snapshot's optimistic merge.
This change needs no relay, database, audio authorization, or CLI changes.

## Acceptance checks

1. Add a member after mounting the room composer; its suggestion becomes
   available without reloading, within the existing refresh interval.
2. Route, thread, and floating chat use the room roster, including members
   who have not authored a message.
3. Full-name, picker, and valid member URI sends contain the expected `p` tag
   in the signed relay event, exactly once per recipient.
4. Unknown or ambiguous names, nonmember identities, and stale picker choices
   cannot produce a misleading huddle send. The draft remains editable.
5. Code examples do not notify, and plain text still sends.
6. Room changes and removals cannot retain another room's recipients.

The baseline web suite at `16b7c8695` passed 2,571 tests while the browser
reproduction failed. Added tests therefore need demonstrated failure before
the repair, followed by a full web suite and browser event verification.

## Separate observation

Voice-mode disarming under a fake silent microphone is not established as a
product defect. It requires a separate real-microphone reproduction; this
typed-mention repair makes no claim about it.
