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
    body: JSON.stringify({
      personaConfig: {
        name: config.personaName || "Evie",
        avatarId: config.avatarId || undefined,
        avatarModel: config.avatarModel || undefined,
        voiceId: config.voiceId || undefined,
        llmId: config.llmId || undefined,
      },
    }),
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
