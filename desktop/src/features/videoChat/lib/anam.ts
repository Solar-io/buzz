import { createClient, type AnamClient } from "@anam-ai/js-sdk";

import type { VideoChatConfig } from "./config";

/**
 * Thin wrapper over the Anam browser SDK.
 *
 * Session tokens are minted here (not in Rust) because the desktop webview is
 * local-only: the API key travels app → Anam directly and is never embedded
 * in any relay event. `llmId` points at the custom LLM Sam registered in
 * Anam Lab — the app's loopback endpoint — so the persona's brain is always
 * the Buzz agent behind the configured DM.
 */
const ANAM_SESSION_TOKEN_URL = "https://api.anam.ai/v1/auth/session-token";

export class AnamError extends Error {}

/**
 * `personaConfig` for the session-token mint. `personaId` (an Anam Lab
 * persona) overrides the avatar/voice trio — the Lab persona bundles them.
 * Field discipline matters: the mint accepts anything, but `/engine/session`
 * re-validates the stored config — a persona id passed as `avatarId` mints
 * fine and then 400s every session start (verified against the live API
 * 2026-08-24).
 */
function buildPersonaConfig(config: VideoChatConfig) {
  if (config.personaId) {
    return {
      name: config.personaName || "Evie",
      personaId: config.personaId,
      llmId: config.llmId || undefined,
    };
  }
  return {
    name: config.personaName || "Evie",
    avatarId: config.avatarId || undefined,
    avatarModel: config.avatarModel || undefined,
    voiceId: config.voiceId || undefined,
    llmId: config.llmId || undefined,
  };
}

/** Flatten an SDK error, keeping Anam's real message — the SDK's own
 * "Invalid request to start session" wrapper hides the cause it carries. */
export function describeAnamError(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as { cause?: { message?: string } | string }).cause;
    const causeMessage =
      typeof cause === "string" ? cause : (cause?.message ?? "");
    return causeMessage ? `${e.message} — ${causeMessage}` : e.message;
  }
  return String(e);
}

async function mintSessionToken(config: VideoChatConfig): Promise<string> {
  if (!config.anamApiKey) {
    throw new AnamError("missing Anam API key — add it in video chat settings");
  }
  const response = await fetch(ANAM_SESSION_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.anamApiKey}`,
    },
    body: JSON.stringify({ personaConfig: buildPersonaConfig(config) }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new AnamError(
      `Anam session token failed (${response.status}): ${detail.slice(0, 200)}`,
    );
  }
  const data = (await response.json()) as { sessionToken?: string };
  if (!data.sessionToken) {
    throw new AnamError("Anam returned no session token");
  }
  return data.sessionToken;
}

/** Create a streaming client attached to `videoElement` (+ its sibling audio element). */
export async function startAnamSession(
  config: VideoChatConfig,
  videoElement: HTMLVideoElement,
  audioElement: HTMLAudioElement,
): Promise<AnamClient> {
  const sessionToken = await mintSessionToken(config);
  const client = createClient(sessionToken);
  // The SDK attaches its streams by element id — video and audio separately.
  if (!videoElement.id) videoElement.id = "buzz-video-chat-persona-video";
  if (!audioElement.id) audioElement.id = "buzz-video-chat-persona-audio";
  await client.streamToVideoAndAudioElements(videoElement.id, audioElement.id);
  return client;
}
