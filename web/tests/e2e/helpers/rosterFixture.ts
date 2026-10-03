import { expect, type Page } from "@playwright/test";
import * as nip44 from "nostr-tools/nip44";
import { installMockRelay, mockEvent, type MockEvent } from "./mockRelay";
import { buildWorkFixture, routeUsageHub } from "./workFixture";
import { signIn } from "./signIn";

interface Command {
  action: string;
  requestId: string;
  target?: string;
  request: { pubkey: string };
}

/** Throwaway owner and agents; desktop responses are simulated at the relay boundary. */
export async function openRoster(
  page: Page,
  options: { autoAck?: boolean; old?: boolean; rejectAdd?: boolean } = {},
) {
  const fixture = buildWorkFixture();
  const agents = [
    fixture.agents.acid,
    fixture.agents.gilfoyle,
    fixture.agents.cereal,
  ];
  let revision = 10_000;
  const event = (value: Partial<MockEvent>) =>
    mockEvent({ id: (revision++).toString(16).padStart(64, "0"), ...value });
  const selfKey = nip44.v2.utils.getConversationKey(
    fixture.viewerKey,
    fixture.viewer,
  );
  const commands: Command[] = [];
  const heads = agents.map((agent, index) =>
    event({
      kind: 30177,
      pubkey: fixture.viewer,
      tags: [["d", agent.pubkey]],
      content: JSON.stringify({
        name: agent.name,
        model: index === 1 ? "sol" : "opus",
        persona_id: index === 0 ? "acid-definition" : undefined,
        system_prompt: "Throwaway test instructions.",
        respond_to: "owner-only",
        effort: { acp: "medium", voice_turn: "low" },
      }),
    }),
  );
  const observer = (pubkey: string, active: boolean) => {
    const agent = agents.find((agent) => agent.pubkey === pubkey);
    if (!agent) throw new Error("Unknown test agent");
    return event({
      kind: 24200,
      pubkey,
      tags: [
        ["p", fixture.viewer],
        ["agent", pubkey],
      ],
      content: nip44.v2.encrypt(
        JSON.stringify({
          seq: revision,
          timestamp: new Date().toISOString(),
          kind: active ? "turn_started" : "turn_completed",
          channelId: fixture.channels.engineering,
          sessionId: "roster-session",
          turnId: "roster-turn",
          agentIndex: 0,
          payload: {},
        }),
        nip44.v2.utils.getConversationKey(agent.secretKey, fixture.viewer),
      ),
    });
  };
  const events = fixture.events.filter(
    (entry) => ![30177, 30180, 24200, 30175, 30176].includes(entry.kind),
  );
  const now = Math.floor(Date.now() / 1000);
  events.push(
    ...heads,
    observer(agents[0].pubkey, true),
    event({
      kind: 30175,
      pubkey: fixture.viewer,
      tags: [["d", "acid-definition"]],
      content: JSON.stringify({
        display_name: "Acid Burn",
        model: "opus",
        runtime: "claude-code",
        system_prompt: "Throwaway test instructions.",
      }),
    }),
    event({
      kind: 30176,
      pubkey: fixture.viewer,
      tags: [["d", "platform"]],
      content: JSON.stringify({
        name: "Platform Team",
        persona_ids: ["acid-definition"],
      }),
    }),
    ...["crichton.local", "second.local"].map((machine, index) =>
      event({
        kind: 30180,
        pubkey: fixture.viewer,
        tags: [["d", machine]],
        created_at: now,
        content: JSON.stringify({
          format: "buzz-desktop-catalog",
          version: 4,
          machine,
          agents: [agents[index].pubkey],
          harnesses: [],
          updated_at: now - (options.old ? 8 * 3600 : 60),
        }),
      }),
    ),
  );
  await page.addInitScript(() => {
    try {
      localStorage.setItem("buzz-theme", "buzz-dark");
      localStorage.setItem("buzz-follow-system", "false");
    } catch {
      /* Opaque preview frames do not have storage. */
    }
  });
  await routeUsageHub(page);
  const relay = await installMockRelay(page, events, {
    successMessage: (entry) =>
      entry.kind === 41010
        ? `response:${JSON.stringify({ channel_id: fixture.channels["dm-gilfoyle"] })}`
        : "",
    rejectPublish: (entry) =>
      options.rejectAdd && entry.kind === 9000
        ? "Channel admin required"
        : null,
    onPublish: (entry, handle) => {
      if (entry.kind === 24201) {
        const command = JSON.parse(
          nip44.v2.decrypt(entry.content, selfKey),
        ) as Command;
        commands.push(command);
        if (options.autoAck !== false) ack(command);
      } else handle.push(entry);
    },
  });
  function ack(command: Command, ok = true, error?: string) {
    relay.push(
      event({
        kind: 24202,
        pubkey: fixture.viewer,
        content: nip44.v2.encrypt(
          JSON.stringify({
            type: "agent_admin_ack",
            requestId: command.requestId,
            ok,
            error,
            agentPubkey: command.request.pubkey,
          }),
          selfKey,
        ),
      }),
    );
    if (ok && command.action === "unregister") {
      const created_at = now + 1;
      relay.remove(
        (entry) =>
          entry.kind === 30177 &&
          entry.tags.some(
            (tag) => tag[0] === "d" && tag[1] === command.request.pubkey,
          ),
      );
      relay.push(
        event({
          kind: 5,
          pubkey: fixture.viewer,
          created_at,
          tags: [["a", `30177:${fixture.viewer}:${command.request.pubkey}`]],
          content: "Unregistered",
        }),
      );
    }
  }
  await signIn(page, "/repos", fixture.viewerKey);
  await expect(
    page.getByTestId(
      (page.viewportSize()?.width ?? 1440) < 768
        ? "phone-tab-bar"
        : "channel-sidebar",
    ),
  ).toBeVisible();
  await page.goto("/repos/settings?group=agents");
  await expect(page.getByTestId("agent-roster")).toBeVisible();
  await expect(page.getByTestId("roster-row")).toHaveCount(3);
  return {
    fixture,
    agents,
    relay,
    commands,
    ack,
    heads,
    working: (pubkey: string, active: boolean) =>
      relay.push(observer(pubkey, active)),
  };
}
