import * as nip44 from "nostr-tools/nip44";
import type { RelaySession } from "@/shared/api/relay-session";
import { signNostrEvent, ownPubkey } from "@/shared/lib/nostr-signer";
import { getUnlockedSecretKey } from "@/shared/lib/key-store";
import { buildObserverEnvelope } from "./agentDrafts.ts";

/**
 * Owner→agent control commands the agent harness understands (buzz-acp
 * handle_observer_control): live model switch and turn cancellation.
 */
export interface SwitchModelCommand {
  type: "switch_model";
  channelId: string;
  modelId: string;
  requestId: string;
}

export interface CancelTurnCommand {
  type: "cancel_turn";
  channelId: string;
  requestId: string;
}

export type AgentControlCommand = SwitchModelCommand | CancelTurnCommand;

/**
 * Publish a control frame: kind 24200, NIP-44 v2 encrypted to the AGENT,
 * tags [p agent][agent agent][frame control] — the owner→agent direction the
 * relay validates (recipient == agent tag, signer != agent).
 */
export async function sendAgentControl(
  session: RelaySession,
  agentPubkey: string,
  command: AgentControlCommand,
): Promise<{ ok: boolean; requestId: string; message: string }> {
  const requestId = command.requestId;
  const secretKey = getUnlockedSecretKey();
  if (!secretKey) {
    return {
      ok: false,
      requestId,
      message: "Unlock your key first — control frames are encrypted.",
    };
  }
  try {
    const payload = buildObserverEnvelope(
      command,
      command.channelId,
      requestId,
    );
    const conversationKey = nip44.v2.utils.getConversationKey(
      secretKey,
      agentPubkey,
    );
    const encrypted = nip44.v2.encrypt(payload, conversationKey);
    const event = await signNostrEvent({
      kind: 24200,
      tags: [
        ["p", agentPubkey],
        ["agent", agentPubkey],
        ["frame", "control"],
      ],
      content: encrypted,
    });
    const result = await session.publish(event);
    return {
      ok: result.ok,
      requestId,
      message: result.ok
        ? "Control command sent."
        : result.message || "The relay rejected the command.",
    };
  } catch (error) {
    return {
      ok: false,
      requestId,
      message:
        error instanceof Error
          ? error.message
          : "Could not encrypt the command.",
    };
  }
}

/** Publish own kind-0 profile (name / about / picture). */
export async function publishOwnProfile(
  session: RelaySession,
  profile: { name: string; about: string; picture: string },
): Promise<{ ok: boolean; message: string }> {
  try {
    const self = await ownPubkey();
    if (!self) {
      return { ok: false, message: "No signing key available." };
    }
    // Only publish a picture when it is a real http(s) URL — anything else
    // (blank, or stray text) would 404 in every avatar render downstream.
    const picture = /^https?:\/\/.+/.test(profile.picture)
      ? profile.picture
      : undefined;
    const event = await signNostrEvent({
      kind: 0,
      tags: [],
      content: JSON.stringify({
        name: profile.name,
        display_name: profile.name,
        about: profile.about,
        ...(picture ? { picture } : {}),
      }),
    });
    const result = await session.publish(event);
    return {
      ok: result.ok,
      message: result.ok
        ? "Profile updated."
        : result.message || "The relay rejected the profile.",
    };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error ? error.message : "Could not sign the profile.",
    };
  }
}
