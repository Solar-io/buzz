/**
 * Applying a template — the side-effecting half.
 *
 * The order matters and is the same order the desktop uses: create the channel
 * first, then provision the roster, then put the provisioned agents *into* the
 * channel. Every failure after the channel exists is reported and skipped
 * rather than aborting, because a created channel cannot be un-created and a
 * half-provisioned channel the user can see beats an error toast over a
 * channel they cannot find.
 *
 * Agent provisioning rides the owner admin-command channel (kind 24201) that
 * the agents page already uses: the browser cannot spawn a process, so the
 * user's own desktop applies the create and acks with the new agent's pubkey.
 * That ack is what makes the kind-9000 add-member step possible at all — with
 * no desktop listening, the roster step reports "no desktop answered" and the
 * channel is still created and usable.
 */

import { useCallback } from "react";

import {
  ADMIN_ACK_KIND,
  parseAdminAck,
  type AdminAckEnvelope,
} from "@/features/agents/lib/adminCommands";
import { sendAdminCommand } from "@/features/agents/lib/adminCommandsSend";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { nip44DecryptFrom, ownPubkey } from "@/shared/lib/nostr-signer";
import { signNostrEvent } from "@/shared/lib/nostr-signer";

import {
  buildAddMemberEvent,
  buildCreateChannelEvent,
  expandRoster,
  type TemplateAgentSpec,
} from "./lib/applyTemplate.ts";
import type { ChannelTemplate } from "./lib/templateModel.ts";
import type { RosterCatalog } from "./useChannelTemplates";

/** How long to wait for the desktop to ack a create before giving up on it. */
const ACK_TIMEOUT_MS = 45_000;

export interface ApplyOutcome {
  channelId: string | null;
  /** Agents the desktop confirmed and that were added to the channel. */
  provisioned: string[];
  /** Roster entries this client could not resolve to a visible persona. */
  skipped: string[];
  /** Human-readable problems that did not stop the apply. */
  problems: string[];
}

type Session = ReturnType<typeof useRelaySession>["session"];

/**
 * Collect acks for a known set of request ids, resolving as soon as every id
 * has answered or the timeout elapses — whichever comes first.
 */
function awaitAcks(
  session: Session,
  selfPubkey: string,
  requestIds: Set<string>,
): Promise<Map<string, AdminAckEnvelope>> {
  return new Promise((resolve) => {
    const acks = new Map<string, AdminAckEnvelope>();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(acks);
    };
    const timer = setTimeout(finish, ACK_TIMEOUT_MS);
    const unsubscribe = session.subscribe(
      { kinds: [ADMIN_ACK_KIND], authors: [selfPubkey] },
      {
        onEvent: (event) => {
          try {
            const { plaintext } = nip44DecryptFrom(event.content, event.pubkey);
            const ack = parseAdminAck(JSON.parse(plaintext));
            if (!ack || !requestIds.has(ack.requestId)) return;
            acks.set(ack.requestId, ack);
            if (acks.size >= requestIds.size) finish();
          } catch {
            // Sealed to another key or malformed — not ours.
          }
        },
      },
    );
  });
}

export function useApplyTemplate() {
  const { session } = useRelaySession();

  return useCallback(
    async (input: {
      template: ChannelTemplate | null;
      channelName: string;
      catalog: RosterCatalog;
      /** Progress for the dialog; called with a short status line. */
      onProgress?: (message: string) => void;
    }): Promise<ApplyOutcome | { error: string }> => {
      const channelId = crypto.randomUUID();
      const built = buildCreateChannelEvent({
        channelId,
        name: input.channelName,
        template: input.template,
      });
      if ("error" in built) return { error: built.error };

      input.onProgress?.("Creating the channel…");
      const createEvent = await signNostrEvent(built.event);
      const createResult = await session.publish(createEvent);
      if (!createResult.ok) {
        return {
          error: createResult.message || "The relay refused the channel.",
        };
      }

      const outcome: ApplyOutcome = {
        channelId,
        provisioned: [],
        skipped: [],
        problems: [],
      };

      const roster = input.template?.agents;
      if (
        !roster ||
        (roster.personas.length === 0 && roster.teams.length === 0)
      ) {
        return outcome;
      }

      const { specs, skipped } = expandRoster(roster, input.catalog);
      outcome.skipped = skipped;
      if (specs.length === 0) return outcome;

      const selfPubkey = await ownPubkey();
      if (!selfPubkey) {
        outcome.problems.push("No unlocked key — agents were not provisioned.");
        return outcome;
      }

      input.onProgress?.(
        `Asking your desktop to create ${specs.length} agent${specs.length === 1 ? "" : "s"}…`,
      );

      // Subscribe BEFORE sending: a fast desktop can ack before a subscription
      // opened afterwards would have seen it.
      const pending = new Map<string, TemplateAgentSpec>();
      const requestIds = new Set<string>();
      const acksPromise = awaitAcks(session, selfPubkey, requestIds);

      for (const spec of specs) {
        const sent = await sendAdminCommand(session, {
          action: "create",
          request: {
            name: spec.name,
            systemPrompt: spec.systemPrompt,
            ...(spec.model ? { model: spec.model } : {}),
            ...(spec.provider ? { provider: spec.provider } : {}),
            ...(spec.harness ? { harness: spec.harness } : {}),
            spawnAfterCreate: true,
            startOnAppLaunch: true,
          },
        });
        if (!sent.ok) {
          outcome.problems.push(
            `${spec.name}: ${sent.message ?? "the relay refused the request"}`,
          );
          continue;
        }
        requestIds.add(sent.requestId);
        pending.set(sent.requestId, spec);
      }

      if (requestIds.size === 0) return outcome;

      input.onProgress?.("Waiting for your desktop to confirm…");
      const acks = await acksPromise;

      if (acks.size === 0) {
        outcome.problems.push(
          "No desktop answered, so no agents were added. The channel is ready; open Buzz Desktop and apply the roster there.",
        );
        return outcome;
      }

      for (const [requestId, spec] of pending) {
        const ack = acks.get(requestId);
        if (!ack) {
          outcome.problems.push(`${spec.name}: no answer from your desktop.`);
          continue;
        }
        if (!ack.ok || !ack.agentPubkey) {
          outcome.problems.push(
            `${spec.name}: ${ack.error ?? "the desktop could not create it"}`,
          );
          continue;
        }
        const addMember = buildAddMemberEvent({
          channelId,
          pubkey: ack.agentPubkey,
          role: "bot",
        });
        if ("error" in addMember) {
          outcome.problems.push(`${spec.name}: ${addMember.error}`);
          continue;
        }
        try {
          const signed = await signNostrEvent(addMember.event);
          const added = await session.publish(signed);
          if (added.ok) {
            outcome.provisioned.push(spec.name);
          } else {
            outcome.problems.push(
              `${spec.name}: created, but the relay refused to add it (${added.message}).`,
            );
          }
        } catch (error) {
          outcome.problems.push(
            `${spec.name}: ${error instanceof Error ? error.message : "could not be added"}`,
          );
        }
      }

      return outcome;
    },
    [session],
  );
}
