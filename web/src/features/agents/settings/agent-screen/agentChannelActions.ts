import {
  publishChannelMemberAdds,
  type MemberEventSender,
} from "@/features/channels/lib/addChannelMembers";
import type { AdminCommand } from "../../lib/adminCommands";

/** An accepted membership add precedes start; a refusal must never start it. */
export async function addAgentChannel({
  channelId,
  pubkey,
  sendMember,
  start,
  refresh,
}: {
  channelId: string;
  pubkey: string;
  sendMember: MemberEventSender;
  start: (command: AdminCommand) => Promise<string | null>;
  refresh: () => void;
}) {
  const outcome = await publishChannelMemberAdds({
    channelId,
    members: [{ pubkey, role: "bot" }],
    send: sendMember,
  });
  if (outcome.failures.length) throw new Error(outcome.failures[0].message);
  if (!outcome.added.length) throw new Error("The agent was not added.");
  // Membership succeeded even if starting later fails. Always re-query it.
  refresh();
  const requestId = await start({ action: "start", request: { pubkey } });
  if (!requestId)
    throw new Error(
      "Added to the channel, but the start command was not sent. Try Start again.",
    );
  return requestId;
}

/** NIP-29 removal, scoped to this channel rather than unregistering an agent. */
export async function removeAgentChannel(
  channelId: string,
  pubkey: string,
  send: MemberEventSender,
  refresh: () => void,
) {
  const result = await send({
    kind: 9001,
    tags: [
      ["h", channelId],
      ["p", pubkey],
    ],
    content: "",
  });
  if (!result.ok)
    throw new Error(result.message || "Could not remove the agent.");
  refresh();
}
