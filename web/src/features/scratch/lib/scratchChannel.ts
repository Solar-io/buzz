/**
 * Scratch channels (web redesign Phase 3) — the pure half.
 *
 * A scratch channel is a private copy of a channel's PEOPLE AND AGENTS with
 * none of its history: `/new` opens one, `/exit` throws it away, `/keep`
 * makes it permanent. The relay already does everything it needs:
 *
 * - kind 9007 creates it, private, with `["ttl","259200"]` — a 72 h IDLE
 *   safety net. The deadline slides on every event (a DB trigger,
 *   migrations/0022_event_ttl_refresh.sql) and the reaper archives it once
 *   the channel has been quiet that long;
 * - one kind 9000 per member of the parent's kind-39002 roster copies the
 *   room, every one at the plain member role (no `role` tag);
 * - kind 9008 deletes it (owner only — the creator is the owner);
 * - kind 9002 with `["ttl",""]` clears the TTL, which is all `/keep` is.
 *
 * The parent link rides in the channel's `about`, the one free-text field a
 * 9007 stores (`handle_create_group` reads `about` and nothing else the
 * client could use; the 39000 is relay-built, so an invented tag would never
 * come back). It reads as a sentence to people and agents, and ends with a
 * machine marker this module parses:
 *
 *     Cloned from #flight-path [parent:10000000-0000-4000-8000-000000000004]
 *
 * The sentence stays true after `/keep`, so a kept channel still says where
 * it came from; what makes a channel SCRATCH is the marker AND a live TTL.
 *
 * Import-free apart from sibling pure modules, so `node --test` loads it.
 */

import {
  buildAddMemberEvent,
  type UnsignedEventTemplate,
} from "../../channel-templates/lib/applyTemplate.ts";
import {
  canonicalChannelName,
  deleteChannelTags,
} from "../../channels/lib/channelAdmin.ts";
import {
  type EphemeralDisplay,
  EPHEMERAL_SOON_SECONDS,
  parseTtlDeadline,
} from "../../channels/lib/ephemeralChannel.ts";
import {
  GROUP_MEMBERS_KIND,
  membersFromMemberEvent,
} from "../../huddle/lib/huddleMembers.ts";

/** 72 hours: the idle window before the relay's reaper archives a scratch. */
export const SCRATCH_TTL_SECONDS = 72 * 60 * 60;

/** The countdown shows only once the idle expiry is closer than this. */
export const SCRATCH_COUNTDOWN_SECONDS = 60 * 60;

/** How long `/exit` waits for Undo before the kind-9008 delete goes out. */
export const SCRATCH_EXIT_UNDO_MS = 10_000;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const MARKER = new RegExp(`\\s*\\[parent:(${UUID})\\]\\s*$`, "i");
const CLONED_FROM = /^Cloned from #(.+?)\s*$/;
const PUBKEY = /^[0-9a-f]{64}$/;

export interface ScratchParent {
  id: string;
  name: string;
}

/** The `about` a scratch channel is created with. */
export function scratchAbout(parent: ScratchParent): string {
  return `Cloned from #${parent.name} [parent:${parent.id.toLowerCase()}]`;
}

/** The parent channel id an `about` links to, or null. */
export function parseScratchParent(
  about: string | null | undefined,
): string | null {
  const match = about ? MARKER.exec(about) : null;
  return match ? match[1].toLowerCase() : null;
}

/**
 * An `about` for display: the marker removed, so a header or a ⌘K hint
 * reads "Cloned from #flight-path" rather than a UUID.
 */
export function withoutScratchMarker(about: string): string {
  return about.replace(MARKER, "");
}

export interface ChannelLike {
  id: string;
  name: string;
  about?: string | null;
  ttlSeconds: number | null;
  ttlDeadline?: string | null;
  archived?: boolean;
}

/**
 * Scratch = the parent marker AND a live TTL. `/keep` clears the TTL and
 * leaves the `about`, so a kept channel is an ordinary channel again.
 */
export function isScratchChannel(channel: ChannelLike): boolean {
  return (
    channel.ttlSeconds !== null && parseScratchParent(channel.about) !== null
  );
}

export interface ScratchInfo {
  parentId: string;
  /**
   * The parent's CURRENT name when it is in the list, else the name the
   * `about` recorded at creation (a renamed or hidden parent still reads).
   */
  parentName: string;
  /** "flight-path / scratch-1" in two halves: the parent, then the rest. */
  label: { parent: string; rest: string };
}

/** Everything the UI shows about a scratch channel, or null for any other. */
export function scratchInfo(
  channel: ChannelLike,
  channels: readonly { id: string; name: string }[],
): ScratchInfo | null {
  if (!isScratchChannel(channel)) {
    return null;
  }
  const parentId = parseScratchParent(channel.about) as string;
  const recorded =
    CLONED_FROM.exec(withoutScratchMarker(channel.about ?? ""))?.[1] ?? "";
  const parentName =
    channels.find((candidate) => candidate.id.toLowerCase() === parentId)
      ?.name ?? recorded;
  return {
    parentId,
    parentName,
    label: scratchLabel(channel.name, recorded || parentName),
  };
}

/**
 * Split `flight-path-scratch-1` into `flight-path` / `scratch-1`. The name
 * was built from the parent's name AT CREATION, so that is the prefix to
 * strip; a scratch renamed by hand keeps its whole name after the slash.
 */
export function scratchLabel(
  name: string,
  parentName: string,
): { parent: string; rest: string } {
  const prefix = `${parentName}-`;
  const rest =
    parentName !== "" &&
    name.toLowerCase().startsWith(prefix.toLowerCase()) &&
    name.length > prefix.length
      ? name.slice(prefix.length)
      : name;
  return { parent: parentName, rest };
}

function slug(text: string): string {
  return canonicalChannelName(text).trim().toLowerCase().replace(/\s+/g, "-");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The new channel's name: `<parent>-scratch-N` with N one past the highest
 * in use, or `<parent>-<name>` when `/new` was given one. Every channel the
 * viewer can see counts as "in use", archived ones included — an archived
 * `-scratch-2` still owns that name in the list.
 */
export function nextScratchName(
  parentName: string,
  existingNames: readonly string[],
  requested: string | null,
): { name: string } | { error: string } {
  const taken = new Set(existingNames.map((name) => name.toLowerCase()));
  const wanted = requested === null ? "" : slug(requested);
  if (requested !== null && wanted === "") {
    return { error: "Give the scratch channel a name, or leave it blank." };
  }
  if (wanted !== "") {
    const base = wanted.startsWith(`${parentName.toLowerCase()}-`)
      ? wanted
      : `${parentName}-${wanted}`;
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n += 1) {
      name = `${base}-${n}`;
    }
    return { name };
  }
  const pattern = new RegExp(
    `^${escapeRegExp(parentName)}-scratch-(\\d+)$`,
    "i",
  );
  let highest = 0;
  for (const name of existingNames) {
    const match = pattern.exec(name);
    if (match) {
      highest = Math.max(highest, Number.parseInt(match[1], 10));
    }
  }
  return { name: `${parentName}-scratch-${highest + 1}` };
}

/** Kind 9007: private stream, the parent link, the 72 h idle TTL. */
export function buildScratchCreateEvent(input: {
  channelId: string;
  name: string;
  parent: ScratchParent;
}): { event: UnsignedEventTemplate } | { error: string } {
  const name = canonicalChannelName(input.name);
  if (name === "") {
    return { error: "channel name is required" };
  }
  if (input.channelId === "" || input.parent.id === "") {
    return { error: "channel id is required" };
  }
  return {
    event: {
      kind: 9007,
      tags: [
        ["h", input.channelId],
        ["name", name],
        ["visibility", "private"],
        ["channel_type", "stream"],
        ["about", scratchAbout(input.parent)],
        ["ttl", String(SCRATCH_TTL_SECONDS)],
      ],
      content: "",
    },
  };
}

/**
 * The newest kind-39002 roster for `channelId` among `events`, decoded to
 * pubkey → role; null when none of them is that channel's snapshot. The
 * relay re-signs the snapshot on every membership change, so an older copy
 * in the same answer is superseded, never merged.
 */
export function newestRoster(
  events: readonly { kind: number; created_at: number; tags: string[][] }[],
  channelId: string,
): Map<string, string> | null {
  let newest: (typeof events)[number] | null = null;
  for (const event of events) {
    if (
      event.kind === GROUP_MEMBERS_KIND &&
      membersFromMemberEvent(event, channelId) !== null &&
      (newest === null || event.created_at > newest.created_at)
    ) {
      newest = event;
    }
  }
  return newest ? membersFromMemberEvent(newest, channelId) : null;
}

/**
 * Who `/new` adds: every member of the parent's roster — people and agents,
 * whatever their role there — except the creator, who is already the
 * scratch channel's owner. Deduplicated, lowercased, and only well-formed
 * keys (a malformed `p` would only come back as a relay refusal).
 */
export function scratchMemberPlan(
  roster: Iterable<string>,
  selfPubkey: string | null,
): string[] {
  const self = selfPubkey?.toLowerCase() ?? null;
  const plan: string[] = [];
  for (const raw of roster) {
    const pubkey = raw.toLowerCase();
    if (pubkey === self || !PUBKEY.test(pubkey) || plan.includes(pubkey)) {
      continue;
    }
    plan.push(pubkey);
  }
  return plan;
}

/** One kind 9000 per planned member, each at the plain member role. */
export function buildScratchMemberEvents(
  channelId: string,
  pubkeys: readonly string[],
): UnsignedEventTemplate[] {
  const events: UnsignedEventTemplate[] = [];
  for (const pubkey of pubkeys) {
    const built = buildAddMemberEvent({ channelId, pubkey });
    if ("event" in built) {
      events.push(built.event);
    }
  }
  return events;
}

/** Kind 9002 for `/keep`: clear the TTL, and rename when a name is given. */
export function buildScratchKeepEvent(
  channelId: string,
  name: string | null,
): { event: UnsignedEventTemplate } | { error: string } {
  const tags: string[][] = [
    ["h", channelId],
    ["ttl", ""],
  ];
  if (name !== null) {
    const canonical = canonicalChannelName(name);
    if (canonical === "") {
      return { error: "That name is empty — /keep [name]." };
    }
    tags.push(["name", canonical]);
  }
  return { event: { kind: 9002, tags, content: "" } };
}

/** Kind 9008 for `/exit`, once the Undo window has passed. */
export function buildScratchDeleteEvent(
  channelId: string,
): UnsignedEventTemplate {
  return { kind: 9008, tags: deleteChannelTags(channelId), content: "" };
}

/**
 * When an idle scratch channel will be archived, in unix seconds.
 *
 * The 39000's `ttl_deadline` is stamped when the relay last emitted the
 * metadata, but the deadline SLIDES on every event and the relay does not
 * re-emit the 39000 for a message. So the newest activity the client has
 * seen can prove a later deadline than the stamp does — the later of the two
 * is the one the reaper will actually use.
 */
export function scratchIdleDeadline(
  channel: Pick<ChannelLike, "ttlSeconds" | "ttlDeadline">,
  lastActivityS: number | null,
): number | null {
  if (channel.ttlSeconds === null) {
    return null;
  }
  const stamped = parseTtlDeadline(channel.ttlDeadline);
  const slid =
    lastActivityS !== null && lastActivityS > 0
      ? lastActivityS + channel.ttlSeconds
      : null;
  if (stamped === null && slid === null) {
    return null;
  }
  return Math.max(stamped ?? 0, slid ?? 0);
}

function humanize(seconds: number): string {
  if (seconds >= 60) {
    return `${Math.floor(seconds / 60)}m`;
  }
  return `${Math.max(0, seconds)}s`;
}

/**
 * The idle countdown, or null. A scratch channel has 72 h to live after
 * every event, so a countdown on it is noise until the end is near: it
 * appears under an hour, turns urgent in the last five minutes.
 */
export function scratchCountdown(
  channel: Pick<ChannelLike, "ttlSeconds" | "ttlDeadline" | "archived">,
  lastActivityS: number | null,
  nowS: number,
): EphemeralDisplay | null {
  if (channel.archived) {
    return {
      label: "ended",
      title: "This scratch channel was idle too long — the relay archived it.",
      secondsRemaining: 0,
      urgency: "expired",
    };
  }
  const deadline = scratchIdleDeadline(channel, lastActivityS);
  if (deadline === null) {
    return null;
  }
  const remaining = Math.floor(deadline - nowS);
  if (remaining > SCRATCH_COUNTDOWN_SECONDS) {
    return null;
  }
  if (remaining <= 0) {
    return {
      label: "expiring",
      title: "Idle too long — the relay archives this scratch channel now.",
      secondsRemaining: 0,
      urgency: "expired",
    };
  }
  return {
    label: `${humanize(remaining)} left`,
    title: `Idle for almost 72 h — archived in ${humanize(remaining)} unless someone posts. /keep makes it permanent.`,
    secondsRemaining: remaining,
    urgency: remaining <= EPHEMERAL_SOON_SECONDS ? "soon" : "normal",
  };
}
