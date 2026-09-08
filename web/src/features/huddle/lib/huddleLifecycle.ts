/**
 * Huddle start flow, mirroring the desktop's steps (desktop/src-tauri
 * huddle/mod.rs): create a private ephemeral stream channel (kind 9007,
 * ttl=3600), post voice-mode guidelines (kind 48106) BEFORE any agent is
 * added, then link it to the parent with a kind-48100 event. Member
 * invites are unnecessary on the web path — the relay auto-adds any parent
 * member who joins the audio room.
 */

import type { RelaySession } from "@/shared/api/relay-session";
import { signNostrEvent } from "@/shared/lib/nostr-signer";
import { buildHuddleGuidelinesEvent } from "./huddleGuidelines.ts";
import { HUDDLE_BACKING_TTL_SECONDS } from "./huddleRegistry.ts";

export async function startHuddle(
  session: RelaySession,
  options: { parentChannelId: string; name?: string },
): Promise<{ ok: boolean; channelId?: string; message: string }> {
  const channelId = crypto.randomUUID();
  const name =
    options.name?.trim().replace(/^#+/, "") ||
    `huddle-${channelId.slice(0, 4)}`;

  const create = await signNostrEvent({
    kind: 9007,
    tags: [
      ["h", channelId],
      ["name", name],
      ["visibility", "private"],
      ["channel_type", "stream"],
      ["ttl", String(HUDDLE_BACKING_TTL_SECONDS)],
    ],
    content: "",
  });
  const created = await session.publish(create);
  if (!created.ok) {
    return {
      ok: false,
      message: created.message || "The relay refused the huddle channel.",
    };
  }

  // Voice-mode guidelines on the ephemeral channel, at the desktop's
  // lifecycle point: after creation, BEFORE any agent is added, so an agent
  // that subscribes on its membership notification has them in the EOSE
  // replay (desktop huddle/mod.rs:261-272). Best-effort by design — a
  // refusal must not fail the huddle (the agents still wake; they only lack
  // the spoken-reply protocol).
  const guidelines = buildHuddleGuidelinesEvent({
    ephemeralChannelId: channelId,
    parentChannelId: options.parentChannelId,
  });
  if ("event" in guidelines) {
    const signedGuidelines = await signNostrEvent(guidelines.event);
    await session.publish(signedGuidelines);
  }

  const link = await signNostrEvent({
    kind: 48100,
    tags: [["h", options.parentChannelId]],
    content: JSON.stringify({ ephemeral_channel_id: channelId }),
  });
  const linked = await session.publish(link);
  if (!linked.ok) {
    return {
      ok: false,
      message:
        linked.message ||
        "The huddle channel was created but the link was refused.",
    };
  }
  return {
    ok: true,
    channelId,
    message: `Huddle "${name}" started — anyone in this channel can join.`,
  };
}
