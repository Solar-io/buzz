import type { CreateAgentFormValue } from "../lib/createAgentRequest";

/** Built-ins until E1b supplies newAgentDefaults from desktop state. */
export function blankAgentDefaults(): CreateAgentFormValue {
  return {
    name: "",
    systemPrompt: "",
    avatarUrl: "",
    model: "",
    provider: "",
    parallelism: "10",
    respondTo: "owner-only",
    respondToAllowlist: [],
    // managed_agents/discovery.rs default_agent_command() is buzz-agent.
    harnessId: "buzz-agent",
    customCommand: "",
    customArgs: "",
    envRows: [],
    startOnAppLaunch: true,
    // buzz-acp/config.rs built-ins; durations remain seconds on the wire.
    idleTimeoutSeconds: "900",
    maxTurnDurationSeconds: "43200",
  };
}
