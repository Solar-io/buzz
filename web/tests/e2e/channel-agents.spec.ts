import { expect } from "@playwright/test";
import * as nip44 from "nostr-tools/nip44";
import { test } from "./helpers/agentBraveTest";
import {
  openShell,
  channelPath,
  shot,
  mainComposer,
} from "./helpers/shellPage";
import {
  hexId,
  mockEvent,
  type MockEvent,
  type MockRelay,
} from "./helpers/mockRelay";
import type { WorkFixture } from "./helpers/workFixture";

function payload(fixture: WorkFixture, event: MockEvent) {
  return JSON.parse(
    nip44.v2.decrypt(
      event.content,
      nip44.v2.utils.getConversationKey(fixture.viewerKey, fixture.viewer),
    ),
  );
}
for (const theme of [
  { name: "dark", id: "buzz-dark" },
  { name: "light", id: "buzz" },
]) {
  for (const width of [1440, 390]) {
    test(`W3 agents at ${width} ${theme.name}: attach/start, lifecycle, instructions and confirmed cleanup`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 960 });
      const retired = Array.from({ length: 9 }, (_, n) =>
        (900 + n).toString(16).padStart(64, "0"),
      );
      let fixture: WorkFixture;
      let clock = Math.floor(Date.now() / 1000) + 100;
      let roster: string[][];
      const snapshot = () =>
        mockEvent({
          id: hexId(++clock),
          kind: 39002,
          created_at: clock,
          tags: [
            ["d", fixture.channels["flight-path"]],
            ["h", fixture.channels["flight-path"]],
            ...roster,
          ],
        });
      const onPublish = (event: MockEvent, handle: MockRelay) => {
        if ([9000, 9001].includes(event.kind)) {
          const pk = event.tags.find((tag) => tag[0] === "p")?.[1];
          if (!pk) throw new Error("Missing member key");
          roster = roster.filter((tag) => tag[1] !== pk);
          if (event.kind === 9000)
            roster.push([
              "p",
              pk,
              "",
              event.tags.find((tag) => tag[0] === "role")?.[1] ?? "member",
            ]);
          handle.push(snapshot());
        }
        if (event.kind === 24201) {
          const command = payload(fixture, event);
          handle.push(
            mockEvent({
              id: hexId(++clock),
              kind: 24202,
              pubkey: fixture.viewer,
              content: nip44.v2.encrypt(
                JSON.stringify({
                  type: "agent_admin_ack",
                  requestId: command.requestId,
                  ok: true,
                  agentPubkey: command.request.pubkey,
                }),
                nip44.v2.utils.getConversationKey(
                  fixture.viewerKey,
                  fixture.viewer,
                ),
              ),
            }),
          );
        }
      };
      const opened = await openShell(page, {
        theme: theme.id,
        path: channelPath(),
        relay: {
          onPublish,
          acceptedMessage: (event) =>
            event.kind === 41010
              ? `response:${JSON.stringify({ channel_id: fixture.channels["dm-gilfoyle"], created: false })}`
              : null,
        },
        extra: (current) => {
          fixture = current;
          roster = [
            ["p", current.viewer, "", "owner"],
            ["p", current.agents.acid.pubkey, "", "bot"],
            ...retired.map((pk) => ["p", pk, "", "bot"]),
          ];
          return [
            snapshot(),
            mockEvent({
              id: hexId(++clock),
              kind: 39002,
              created_at: clock,
              tags: [
                ["d", current.channels["dm-gilfoyle"]],
                ["h", current.channels["dm-gilfoyle"]],
                ["p", current.viewer, "", "member"],
                ["p", current.agents.gilfoyle.pubkey, "", "bot"],
              ],
            }),
            ...Object.values(current.agents).map((agent) =>
              mockEvent({
                id: hexId(++clock),
                kind: 30177,
                pubkey: current.viewer,
                created_at: clock,
                tags: [["d", agent.pubkey]],
                content: JSON.stringify({
                  name: agent.name,
                  model: "opus",
                  effort: { acp: "medium" },
                  respond_to: "owner-only",
                }),
              }),
            ),
            mockEvent({
              id: hexId(++clock),
              kind: 30180,
              pubkey: current.viewer,
              created_at: clock,
              tags: [["d", "crichton.local"]],
              content: JSON.stringify({
                format: "buzz-desktop-catalog",
                version: 4,
                machine: "crichton.local",
                harnesses: [],
                agents: Object.values(current.agents).map(
                  (agent) => agent.pubkey,
                ),
                updated_at: clock,
              }),
            }),
            ...retired.map((pk, index) =>
              mockEvent({
                id: hexId(++clock),
                kind: 0,
                pubkey: pk,
                content: JSON.stringify({
                  display_name: `Retired Agent ${index + 1}`,
                }),
              }),
            ),
          ];
        },
      });
      const { relay } = opened;
      fixture = opened.fixture;
      await page.getByTestId("channel-members-trigger").click();
      const sheet = page.getByTestId("channel-settings-sheet");
      await expect(
        sheet.getByRole("button", { name: "Remove 9", exact: true }),
      ).toBeVisible();
      await expect(
        sheet.getByTestId(`agent-member-${fixture.agents.acid.pubkey}`),
      ).toContainText("Working elsewhere");
      await expect(
        sheet.getByTestId(`agent-member-${fixture.agents.acid.pubkey}`),
      ).toContainText("opus · medium");
      await sheet.evaluate((element) =>
        Promise.all(
          element
            .getAnimations({ subtree: true })
            .filter(
              (animation) =>
                animation.effect?.getComputedTiming().iterations !== Infinity,
            )
            .map((animation) => animation.finished.catch(() => {})),
        ),
      );
      expect(
        await sheet.evaluate((element) => ({
          overflow: element.scrollWidth > element.clientWidth,
          right: element.getBoundingClientRect().right,
          left: element.getBoundingClientRect().left,
        })),
      ).toEqual({
        overflow: false,
        right: width,
        left: width === 390 ? 0 : 960,
      });
      await shot(page, `w3-members-${width}-${theme.name}`);
      await sheet.getByRole("button", { name: "Agent", exact: true }).click();
      const picker = page.getByRole("dialog", {
        name: "Add an agent",
        exact: true,
      });
      await expect(
        picker.getByRole("button", { name: "Add Acid Burn", exact: true }),
      ).toHaveCount(0);
      await expect(
        picker.getByRole("button", { name: "Add Gilfoyle", exact: true }),
      ).toBeVisible();
      await shot(page, `w3-picker-${width}-${theme.name}`);
      await picker
        .getByRole("button", { name: "Add Gilfoyle", exact: true })
        .click();
      await expect(picker).not.toBeVisible();
      await expect(
        sheet.getByTestId(`agent-member-${fixture.agents.gilfoyle.pubkey}`),
      ).toBeVisible();
      const changes = relay.published.filter((event) =>
        [9000, 24201].includes(event.kind),
      );
      expect(changes.map((event) => event.kind)).toEqual([9000, 24201]);
      expect(changes[0].tags).toEqual([
        ["h", fixture.channels["flight-path"]],
        ["p", fixture.agents.gilfoyle.pubkey],
        ["role", "bot"],
      ]);
      expect(payload(fixture, changes[1])).toMatchObject({
        action: "start",
        target: "crichton.local",
        request: { pubkey: fixture.agents.gilfoyle.pubkey },
      });
      await sheet
        .getByRole("button", { name: "Stop all", exact: true })
        .click();
      await expect(sheet.getByRole("status")).toContainText(
        "Stop all acknowledged",
      );
      await sheet
        .getByRole("button", { name: "Start all", exact: true })
        .click();
      await expect(sheet.getByRole("status")).toContainText(
        "Start all acknowledged",
      );
      const commands = relay.published
        .filter((event) => event.kind === 24201)
        .map((event) => payload(fixture, event));
      expect(commands.map((command) => command.action)).toEqual([
        "start",
        "stop",
        "stop",
        "start",
        "start",
      ]);
      await sheet
        .getByRole("button", { name: "More for Gilfoyle", exact: true })
        .click();
      await expect(
        page.getByRole("menuitem", { name: "Agent settings", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("menuitem", { name: "Message Gilfoyle", exact: true }),
      ).toBeVisible();
      await shot(page, `w3-menu-${width}-${theme.name}`);
      await page
        .getByRole("menuitem", { name: "Who can instruct…", exact: true })
        .click();
      const instruction = page.getByRole("dialog", {
        name: "Who can instruct Gilfoyle",
        exact: true,
      });
      await instruction.getByRole("combobox").selectOption("anyone");
      await expect(instruction).toContainText("access its workspace");
      await shot(page, `w3-instructions-${width}-${theme.name}`);
      await instruction
        .getByRole("button", { name: "Save", exact: true })
        .click();
      await expect(instruction).not.toBeVisible();
      const update = relay.published
        .filter((event) => event.kind === 24201)
        .map((event) => payload(fixture, event))
        .at(-1);
      expect(update.request).toEqual({
        pubkey: fixture.agents.gilfoyle.pubkey,
        respondTo: "anyone",
        respondToAllowlist: [],
      });
      // Agent Brave has multiple CDP clients: a native dialog can already be
      // handled by another client. Capture this page's real confirm call;
      // cancel/accept branching is independently exercised by the unit suite.
      await page.evaluate(() => {
        window.confirm = (message) => {
          document.body.dataset.w3Confirmation = message;
          return true;
        };
      });
      await sheet
        .getByRole("button", { name: "Remove 9", exact: true })
        .click();
      await expect
        .poll(
          () => relay.published.filter((event) => event.kind === 9001).length,
        )
        .toBe(9);
      await expect(sheet.getByRole("status")).toContainText(
        "Removals accepted",
      );
      const confirmed = await page
        .locator("body")
        .getAttribute("data-w3-confirmation");
      await expect(
        sheet.getByRole("button", { name: "Remove 9", exact: true }),
      ).toHaveCount(0);
      expect(confirmed).toContain("Retired Agent 1");
      expect(confirmed).toContain("Retired Agent 9");
      const removals = relay.published.filter((event) => event.kind === 9001);
      expect(removals).toHaveLength(9);
      expect(removals.map((event) => event.tags[1][1]).sort()).toEqual(
        retired.sort(),
      );
      await sheet
        .getByRole("button", { name: "More for Gilfoyle", exact: true })
        .click();
      await page
        .getByRole("menuitem", { name: "Agent settings", exact: true })
        .click();
      await expect(page.getByTestId("agent-screen")).toBeVisible();
      expect(page.url()).toContain(`agent=${fixture.agents.gilfoyle.pubkey}`);
      await page.goBack();
      await page.getByTestId("channel-members-trigger").click();
      await sheet
        .getByRole("button", { name: "More for Gilfoyle", exact: true })
        .click();
      await page
        .getByRole("menuitem", { name: "Message Gilfoyle", exact: true })
        .click();
      await expect(page).toHaveURL(new RegExp(fixture.channels["dm-gilfoyle"]));
      await expect(sheet).toHaveCount(0);
      await expect(mainComposer(page)).toHaveAttribute(
        "aria-description",
        "Gilfoyle will be notified",
      );
    });
  }
}
