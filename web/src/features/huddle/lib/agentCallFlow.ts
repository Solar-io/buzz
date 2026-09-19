/**
 * The one-click DM voice-call sequence.
 *
 * A DM is the conversation the user chose, but it is not an audio room. The
 * caller provisions a private TTL huddle, joins it, admits exactly the DM
 * agent, and only then arms voice mode. Keeping the sequence here makes the
 * guards observable without mounting the app-wide audio provider in a unit
 * test.
 */

export type AgentCallPhase =
  | "idle"
  | "creating"
  | "joining"
  | "adding"
  | "arming"
  | "active";

export interface AgentCallResult {
  ok: boolean;
  message: string;
}

export interface AgentCallObservation {
  huddleChannelId: string | null;
  parentChannelId: string | null;
  connected: boolean;
  status: string;
  error?: string | null;
  agentPubkeys: readonly string[];
}

export interface AgentCallFlowOptions {
  parentChannelId: string;
  agentPubkey: string;
  agentName: string;
  /** Reuse only a room the caller has already identified as compatible. */
  existingHuddleChannelId?: string | null;
}

export interface AgentCallFlowHandlers {
  observe: () => AgentCallObservation;
  setPhase: (phase: AgentCallPhase) => void;
  provision: () => Promise<{
    ok: boolean;
    channelId?: string;
    message: string;
  }>;
  requestJoin: (target: {
    huddleChannelId: string;
    parentChannelId: string;
  }) => AgentCallResult;
  addAgent: (input: {
    agentPubkey: string;
    agentName: string;
  }) => Promise<AgentCallResult>;
  armVoice: () => void;
  /** Waits for an observation to satisfy a transport or roster predicate. */
  waitFor: (
    predicate: (observation: AgentCallObservation) => boolean,
  ) => Promise<boolean>;
  /** Leaves a partial call after a failed agent admission or roster wait. */
  abortPartialCall: () => void;
  /** Invalidates this flow when a newer intent has taken ownership. */
  isCurrent: () => boolean;
}

const cancelled = (): AgentCallResult => ({
  ok: false,
  message: "The call request was cancelled.",
});

const failed = (message: string): AgentCallResult => ({
  ok: false,
  message: message || "The voice call could not be started.",
});

function samePubkey(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * Run the DM call sequence. `waitFor` must observe the provider's current
 * call, so an async permission prompt or relay join cannot arm a stale room.
 */
export async function runAgentCallFlow(
  options: AgentCallFlowOptions,
  handlers: AgentCallFlowHandlers,
): Promise<AgentCallResult> {
  const current = () => handlers.isCurrent();
  const fail = (message: string, cleanup = false): AgentCallResult => {
    if (current()) {
      if (cleanup) {
        handlers.abortPartialCall();
      }
      handlers.setPhase("idle");
    }
    return failed(message);
  };

  let huddleChannelId = options.existingHuddleChannelId ?? null;
  if (!huddleChannelId) {
    handlers.setPhase("creating");
    if (!current()) {
      return cancelled();
    }
    let provisioned: Awaited<ReturnType<AgentCallFlowHandlers["provision"]>>;
    try {
      provisioned = await handlers.provision();
    } catch (error) {
      return fail(
        error instanceof Error
          ? error.message
          : "The huddle could not be created.",
      );
    }
    if (!current()) {
      return cancelled();
    }
    if (!provisioned.ok || !provisioned.channelId) {
      return fail(provisioned.message);
    }
    huddleChannelId = provisioned.channelId;
  }

  handlers.setPhase("joining");
  if (!current()) {
    return cancelled();
  }
  const join = handlers.requestJoin({
    huddleChannelId,
    parentChannelId: options.parentChannelId,
  });
  if (!join.ok) {
    return fail(join.message);
  }

  let connected = false;
  try {
    connected = await handlers.waitFor(
      (observation) =>
        observation.connected &&
        observation.huddleChannelId === huddleChannelId &&
        observation.parentChannelId === options.parentChannelId,
    );
  } catch (error) {
    return fail(
      error instanceof Error
        ? error.message
        : "The huddle could not be joined.",
    );
  }
  if (!current()) {
    return cancelled();
  }
  if (!connected) {
    const observation = handlers.observe();
    return fail(
      observation.status === "error"
        ? (observation.error ??
            "The huddle could not be joined. Retry the call.")
        : "The huddle did not connect in time. Retry the call.",
      true,
    );
  }

  const observation = handlers.observe();
  const targetPresent = observation.agentPubkeys.some((pubkey) =>
    samePubkey(pubkey, options.agentPubkey),
  );
  const otherAgentPresent = observation.agentPubkeys.some(
    (pubkey) => !samePubkey(pubkey, options.agentPubkey),
  );
  // A direct call may never silently turn into a multi-agent call. If a
  // reused room has another bot in it, leave it and make the next click start
  // a clean room for this DM.
  if (otherAgentPresent) {
    return fail(
      "That huddle already has another agent in it. Leave it and retry this DM.",
      true,
    );
  }

  if (!targetPresent) {
    handlers.setPhase("adding");
    if (!current()) {
      return cancelled();
    }
    let added: AgentCallResult;
    try {
      added = await handlers.addAgent({
        agentPubkey: options.agentPubkey,
        agentName: options.agentName,
      });
    } catch (error) {
      return fail(
        error instanceof Error
          ? error.message
          : "The relay refused the huddle agent add.",
        true,
      );
    }
    if (!current()) {
      return cancelled();
    }
    if (!added.ok) {
      return fail(added.message, true);
    }
  }

  handlers.setPhase("arming");
  let confirmed = false;
  try {
    confirmed = await handlers.waitFor((next) => {
      const exact = next.agentPubkeys.some((pubkey) =>
        samePubkey(pubkey, options.agentPubkey),
      );
      const other = next.agentPubkeys.some(
        (pubkey) => !samePubkey(pubkey, options.agentPubkey),
      );
      return (
        next.connected &&
        next.huddleChannelId === huddleChannelId &&
        next.parentChannelId === options.parentChannelId &&
        exact &&
        !other
      );
    });
  } catch (error) {
    return fail(
      error instanceof Error
        ? error.message
        : "The huddle roster could not be confirmed.",
      true,
    );
  }
  if (!current()) {
    return cancelled();
  }
  if (!confirmed) {
    return fail(
      "The agent was added, but the huddle roster did not confirm it. Retry the call.",
      true,
    );
  }

  handlers.armVoice();
  handlers.setPhase("active");
  return {
    ok: true,
    message: `${options.agentName} is on the call.`,
  };
}
