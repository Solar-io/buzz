import { useRef, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { MoreHorizontal } from "lucide-react";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { signNostrEvent } from "@/shared/lib/nostr-signer";
import { openDm } from "@/features/dms/hooks";
import type { AgentRegistryEntry } from "@/features/agents/lib/agentRegistry";
import { useDesktopCatalogs } from "@/features/agents/useDesktopCatalogs";
import { useObserverStore } from "@/features/agents/ObserverProvider";
import { agentNow } from "@/features/agents/settings/agent-screen/agentScreenModel";
import { useTick } from "@/features/agents/ui/WorkingBadge";
import { Button } from "@/shared/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import type { ChannelMember, Profile } from "../../hooks";
import { authorLabel } from "../../lib/authorLabel";
import {
  channelAgentCandidates,
  channelAgentTarget,
  runChannelAgentBatch,
  startAfterAttach,
  unregisteredChannelAgents,
} from "../../lib/channelAgents";
import { removeAgentChannel } from "@/features/agents/settings/agent-screen/agentChannelActions";
import { AuthorAvatar } from "../AuthorAvatar";
import { AgentPickerSheet } from "./AgentPickerSheet";
import { AgentInstructionDialog } from "./AgentInstructionDialog";
import { UnregisteredBanner } from "./UnregisteredBanner";
import { useChannelAgentCommands } from "./useChannelAgentCommands";

/** Channel membership and owner-signed lifecycle remain separate, acknowledged operations. */
export function AgentMembersSection({
  channelId,
  members,
  people,
  profiles,
  registry,
  archived,
  canManage,
  isMember,
  query,
  pickerOpen,
  onPickerClose,
  peopleSection,
}: {
  channelId: string;
  members: ChannelMember[];
  people: ChannelMember[];
  profiles: Map<string, Profile>;
  registry: AgentRegistryEntry[];
  archived: boolean;
  canManage: boolean;
  isMember: boolean;
  query: string;
  pickerOpen: boolean;
  onPickerClose: () => void;
  peopleSection?: ReactNode;
}) {
  const { session, status } = useRelaySession();
  const catalogs = useDesktopCatalogs();
  const observer = useObserverStore();
  const send = useChannelAgentCommands();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [instructions, setInstructions] = useState<AgentRegistryEntry | null>(
    null,
  );
  useTick(true);
  const now = Math.floor(Date.now() / 1000);
  const stale = unregisteredChannelAgents(members, registry, catalogs, now);
  const staleKeys = new Set(stale.map((entry) => entry.pubkey));
  const candidates = channelAgentCandidates(registry, members, catalogs, now);
  const locked = busy || archived || status !== "open";
  const reason = (pubkey: string) =>
    !channelAgentTarget(pubkey, catalogs, now)
      ? "Open Buzz Desktop on the agent's computer to change it here."
      : locked
        ? "Wait for the current change or connect to the relay."
        : null;
  const target = (pubkey: string) => {
    if (archived || status !== "open")
      throw new Error("Connect and unarchive the channel to change agents.");
    const machine = channelAgentTarget(pubkey, catalogs);
    if (!machine)
      throw new Error(
        "No recently reporting desktop uniquely claims this agent. Open Buzz Desktop and try again.",
      );
    return machine;
  };
  const sendMember = async (event: {
    kind: number;
    tags: string[][];
    content: string;
  }) => {
    if (archived || status !== "open")
      throw new Error("Connect and unarchive the channel to change members.");
    const result = await session.publish(await signNostrEvent(event));
    return {
      ok: result.ok,
      message: result.message || "The relay refused the change.",
    };
  };
  const run = async (action: () => Promise<void>, success: string) => {
    if (inFlight.current)
      throw new Error("Wait for the current change to finish.");
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(success);
    } catch (issue) {
      const message =
        issue instanceof Error ? issue.message : "Could not change agents.";
      setError(message);
      throw issue;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const act = (action: () => Promise<void>, success: string) =>
    void run(action, success).catch(() => {});
  const remove = async (pubkey: string) => {
    if (!canManage)
      throw new Error("Only channel owners and admins can remove agents.");
    await removeAgentChannel(channelId, pubkey, sendMember, () => {});
  };
  const bulk = async (action: "start" | "stop") => {
    if (!canManage)
      throw new Error("Only channel owners and admins can change all agents.");
    const eligible = members.filter((member) => !staleKeys.has(member.pubkey));
    const results = await runChannelAgentBatch(eligible, async (member) => {
      await send(
        { action, request: { pubkey: member.pubkey } },
        target(member.pubkey),
      );
    });
    const failed = results.filter((result) => result.error);
    if (failed.length)
      throw new Error(
        `${results.length - failed.length} of ${results.length} agents changed. ${failed.map(({ entry, error: issue }) => `${authorLabel(entry.pubkey, profiles)}: ${issue}`).join("; ")}`,
      );
  };
  const labelFor = (pubkey: string) =>
    registry.find((entry) => entry.pubkey === pubkey)?.name ??
    authorLabel(pubkey, profiles);
  const cleanup = () => {
    const names = stale.map((entry) => labelFor(entry.pubkey));
    if (
      !window.confirm(
        `Remove ${stale.length} unregistered agents from this channel?\n\n${names.join("\n")}`,
      )
    )
      return;
    act(async () => {
      for (const entry of stale) await remove(entry.pubkey);
    }, "Removals accepted. Waiting for the updated member list.");
  };
  const registeredCount = members.length - stale.length;
  return (
    <section aria-label="Agents" className="space-y-3">
      <UnregisteredBanner
        count={stale.length}
        canRemove={canManage}
        busy={locked}
        onRemove={cleanup}
      />
      {peopleSection}
      <div className="flex flex-wrap items-center gap-1">
        <h2 className="mr-auto text-2xs uppercase tracking-wider text-muted-foreground">
          Agents · {registeredCount} registered
        </h2>
        {canManage && (
          <>
            <Button
              variant="ghost"
              size="sm"
              className="min-h-11"
              disabled={locked || !registeredCount}
              onClick={() =>
                act(() => bulk("start"), "Start all acknowledged by Desktop.")
              }
            >
              Start all
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="min-h-11"
              disabled={locked || !registeredCount}
              onClick={() =>
                act(() => bulk("stop"), "Stop all acknowledged by Desktop.")
              }
            >
              Stop all
            </Button>
          </>
        )}
      </div>
      {error && (
        <p role="alert" className="break-words text-sm text-coral-ink">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-xs text-ink-2">
          {notice}
        </p>
      )}
      <ul>
        {members
          .filter((member) =>
            `${labelFor(member.pubkey)} ${member.pubkey}`
              .toLowerCase()
              .includes(query),
          )
          .sort(
            (left, right) =>
              Number(staleKeys.has(left.pubkey)) -
                Number(staleKeys.has(right.pubkey)) ||
              labelFor(left.pubkey).localeCompare(labelFor(right.pubkey)),
          )
          .map((member) => {
            const agent = registry.find(
              (entry) => entry.pubkey === member.pubkey,
            );
            const label = labelFor(member.pubkey);
            const working = agentNow(
              member.pubkey,
              observer?.byAgent.get(member.pubkey) ?? [],
              now,
            ).turns[0];
            const registered = !staleKeys.has(member.pubkey);
            return (
              <li
                key={member.pubkey}
                data-testid={`agent-member-${member.pubkey}`}
                className="flex min-h-14 min-w-0 items-center gap-2 rounded-lg px-1 py-1 hover:bg-accent/50"
              >
                <AuthorAvatar
                  pubkey={member.pubkey}
                  label={label}
                  picture={profiles.get(member.pubkey)?.avatar}
                  size="md-sm"
                  className="rounded-none [clip-path:polygon(50%_0,100%_25%,100%_75%,50%_100%,0_75%,0_25%)]"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{label}</p>
                  <p
                    className="truncate text-xs text-muted-foreground"
                    title={agent?.model}
                  >
                    {registered
                      ? working
                        ? working.channelId === channelId
                          ? "Working here"
                          : "Working elsewhere"
                        : "Runtime status unavailable"
                      : "Not registered"}
                    {agent?.model ? ` · ${agent.model}` : ""}
                    {agent?.effort?.acp ? ` · ${agent.effort.acp}` : ""}
                  </p>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={`More for ${label}`}
                      className="flex size-11 shrink-0 items-center justify-center rounded-lg text-ink-2 hover:bg-accent"
                    >
                      <MoreHorizontal aria-hidden className="size-4" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    className="max-w-[calc(100vw-2rem)]"
                  >
                    {agent && (
                      <DropdownMenuItem
                        className="min-h-11"
                        onSelect={() =>
                          void navigate({
                            to: "/repos/settings",
                            search: { group: "agents", agent: member.pubkey },
                          })
                        }
                      >
                        Agent settings
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem
                      className="min-h-11"
                      disabled={locked}
                      onSelect={() =>
                        act(async () => {
                          const result = await openDm(session, [member.pubkey]);
                          if (!result.ok || !result.channelId)
                            throw new Error(
                              result.message ||
                                "Could not open the conversation.",
                            );
                          await navigate({
                            to: "/repos",
                            search: { c: result.channelId },
                          });
                        }, "Conversation opened.")
                      }
                    >
                      Message {label}
                    </DropdownMenuItem>
                    {agent && (
                      <DropdownMenuItem
                        className="min-h-11"
                        disabled={locked || !!reason(member.pubkey)}
                        onSelect={() => setInstructions(agent)}
                      >
                        Who can instruct…
                      </DropdownMenuItem>
                    )}
                    {canManage && (
                      <>
                        <DropdownMenuItem
                          className="min-h-11"
                          disabled={
                            locked || !registered || !!reason(member.pubkey)
                          }
                          onSelect={() =>
                            act(async () => {
                              await send(
                                {
                                  action: "stop",
                                  request: { pubkey: member.pubkey },
                                },
                                target(member.pubkey),
                              );
                            }, "Stop acknowledged by Desktop.")
                          }
                        >
                          Stop {label}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="min-h-11 text-coral-ink focus:text-coral-ink"
                          disabled={locked}
                          onSelect={() => {
                            if (
                              window.confirm(
                                `Remove ${label} from this channel?`,
                              )
                            )
                              act(
                                () => remove(member.pubkey),
                                "Removal accepted. Waiting for the updated member list.",
                              );
                          }}
                        >
                          Remove from channel
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            );
          })}
      </ul>
      {!members.length && (
        <p className="text-sm text-muted-foreground">
          No agents in this channel yet.
        </p>
      )}
      {pickerOpen && (
        <AgentPickerSheet
          agents={candidates}
          disabledReason={reason}
          onClose={onPickerClose}
          onAdd={(pubkey) =>
            run(async () => {
              if (!isMember)
                throw new Error("Join the channel to add an agent.");
              const machine = target(pubkey);
              if (
                !channelAgentCandidates(registry, members, catalogs).some(
                  (agent) => agent.pubkey === pubkey,
                )
              )
                throw new Error(
                  "This agent is already here or is no longer available.",
                );
              await startAfterAttach({
                channelId,
                pubkey,
                sendMember,
                refresh: () => {},
                start: (command) => send(command, machine),
              });
            }, "Agent added; start acknowledged by Desktop.")
          }
        />
      )}
      {instructions && (
        <AgentInstructionDialog
          agent={instructions}
          people={people}
          profiles={profiles}
          locked={locked || !!reason(instructions.pubkey)}
          onClose={() => setInstructions(null)}
          onSave={(mode, allowlist) =>
            run(async () => {
              await send(
                {
                  action: "update",
                  request: {
                    pubkey: instructions.pubkey,
                    respondTo: mode,
                    respondToAllowlist: mode === "allowlist" ? allowlist : [],
                  },
                },
                target(instructions.pubkey),
              );
            }, "Who can instruct saved by Desktop. Takes effect on restart.")
          }
        />
      )}
    </section>
  );
}
