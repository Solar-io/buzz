import * as React from "react";

/**
 * Video-chat configuration, persisted locally per install.
 *
 * The Anam API key never leaves the desktop app (the session token is minted
 * directly against Anam's auth endpoint); the persona fields map 1:1 to the
 * `personaConfig` of Anam's session-token request.
 */
export interface VideoChatConfig {
  anamApiKey: string;
  personaName: string;
  /** Anam Lab persona id — when set, it overrides avatar/voice (the Lab persona bundles them). */
  personaId: string;
  avatarId: string;
  avatarModel: string;
  voiceId: string;
  llmId: string;
}

const STORAGE_KEY = "buzz.videoChat.config.v1";

const EMPTY: VideoChatConfig = {
  anamApiKey: "",
  personaName: "Evie",
  personaId: "",
  avatarId: "",
  avatarModel: "",
  voiceId: "",
  llmId: "",
};

export function loadVideoChatConfig(): VideoChatConfig {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...EMPTY };
    const parsed = JSON.parse(raw) as Partial<VideoChatConfig>;
    return { ...EMPTY, ...parsed };
  } catch {
    return { ...EMPTY };
  }
}

export function saveVideoChatConfig(config: VideoChatConfig): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // Storage unavailable (private mode, quota) — config stays in-memory.
  }
}

/** Config as a React hook with a save callback. */
export function useVideoChatConfig(): {
  config: VideoChatConfig;
  update: (patch: Partial<VideoChatConfig>) => void;
} {
  const [config, setConfig] =
    React.useState<VideoChatConfig>(loadVideoChatConfig);
  const update = React.useCallback((patch: Partial<VideoChatConfig>) => {
    setConfig((prev) => {
      const next = { ...prev, ...patch };
      saveVideoChatConfig(next);
      return next;
    });
  }, []);
  return { config, update };
}
