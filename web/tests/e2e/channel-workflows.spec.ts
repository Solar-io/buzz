import { expect } from "@playwright/test";
import { verifyEvent } from "nostr-tools/pure";
import { test } from "./helpers/agentBraveTest";
import { channelPath, openShell, shot } from "./helpers/shellPage";
import { hexId, mockEvent } from "./helpers/mockRelay";

const YAML = `name: Channel workflow
trigger:
  on: message_posted
  filter: 'trigger_text == "w5b-run"'
steps:
  - id: wait
    action: delay
    duration: 1s
`;
const workflowId = "539e70c4-4da0-47cb-974f-d90b17825345";

for (const theme of [
  { id: "buzz-dark", name: "dark" },
  { id: "buzz", name: "light" },
]) {
  for (const width of [1440, 390]) {
    test(`W5b create, edit, run status, validation and refusal at ${width} ${theme.name}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.route("**/workflows/*/runs*", (route) =>
        route.fulfill({
          json: {
            runs: [
              {
                id: "run-1",
                workflow_id: workflowId,
                status: "completed",
                created_at: 1,
                execution_trace: [],
              },
            ],
            next: null,
          },
        }),
      );
      const { fixture, relay } = await openShell(page, {
        theme: theme.id,
        path: channelPath(),
        extra: (fixture) => [
          mockEvent({
            kind: 39002,
            id: hexId(7099),
            tags: [
              ["d", fixture.channels["flight-path"]],
              ["h", fixture.channels["flight-path"]],
              ["p", fixture.viewer],
            ],
          }),
          mockEvent({
            kind: 30620,
            id: hexId(7100),
            pubkey: fixture.viewer,
            created_at: Math.floor(Date.now() / 1000) - 120,
            tags: [
              ["d", workflowId],
              ["h", fixture.channels["flight-path"]],
            ],
            content: YAML,
          }),
          mockEvent({
            kind: 30620,
            id: hexId(7101),
            pubkey: fixture.viewer,
            tags: [
              ["d", "fd5b8f94-ef83-44f3-957f-14ef3fb5d2b0"],
              ["h", fixture.channels.engineering],
            ],
            content: YAML.replace("Channel workflow", "Other channel workflow"),
          }),
          mockEvent({
            kind: 30620,
            id: hexId(7102),
            pubkey: fixture.agents.acid.pubkey,
            tags: [
              ["d", "49b0752a-83ea-4ce1-a59f-c2cbe0fa59f4"],
              ["h", fixture.channels["flight-path"]],
            ],
            content: YAML.replace(
              "Channel workflow",
              "Someone else's workflow",
            ),
          }),
        ],
        relay: {
          onPublish: (event, relay) => {
            if (event.kind === 30620) relay.push(event);
          },
          rejectPublish: (event) =>
            event.kind === 30620 && event.content.includes("action: unknown")
              ? "invalid: workflow YAML parse error: unknown action"
              : null,
        },
      });
      await page.getByTestId("channel-settings-trigger").click();
      const sheet = page.getByTestId("channel-settings-sheet");
      await sheet.getByRole("tab", { name: "Workflows", exact: true }).click();
      await expect(
        sheet.getByRole("heading", { name: "Channel workflow", exact: true }),
      ).toBeVisible();
      await expect(
        sheet.getByText("completed", { exact: true }).first(),
      ).toBeVisible();
      await expect(
        sheet.getByText("Other channel workflow", { exact: true }),
      ).toHaveCount(0);
      await expect(
        sheet.getByRole("button", { name: "Edit Someone else's workflow" }),
      ).toHaveCount(0);
      await shot(page, `w5b-list-${width}-${theme.name}`);
      await sheet
        .getByRole("button", { name: "New workflow", exact: true })
        .click();
      const editor = sheet.getByLabel("Workflow YAML");
      const save = sheet.getByRole("button", { name: "Save", exact: true });
      await editor.fill("name: Broken\ntrigger:\n  on: [bad\n");
      await expect(save).toBeDisabled();
      await expect(sheet.getByRole("alert")).toContainText("line 3");
      await shot(page, `w5b-invalid-${width}-${theme.name}`);
      await editor.fill(YAML.replace("Channel workflow", "Created in W5b"));
      await save.click();
      await expect(
        sheet.getByRole("heading", { name: "Created in W5b", exact: true }),
      ).toBeVisible();
      const created = relay.published.filter((event) => event.kind === 30620);
      expect(created).toHaveLength(1);
      expect(verifyEvent(created[0])).toBe(true);
      expect(created[0].pubkey).toBe(fixture.viewer);
      expect(created[0].tags[1]).toEqual([
        "h",
        fixture.channels["flight-path"],
      ]);
      await sheet
        .getByRole("button", { name: "Edit Channel workflow", exact: true })
        .click();
      await editor.fill(YAML.replace("Channel workflow", "Edited in W5b"));
      await save.click();
      await expect(
        sheet.getByRole("heading", { name: "Edited in W5b", exact: true }),
      ).toBeVisible();
      const edited = relay.published.filter((event) => event.kind === 30620)[1];
      expect(verifyEvent(edited)).toBe(true);
      expect(edited.tags).toEqual([
        ["d", workflowId],
        ["h", fixture.channels["flight-path"]],
        ["expected-revision", hexId(7100)],
      ]);
      await sheet
        .getByRole("button", { name: "Edit Edited in W5b", exact: true })
        .click();
      await editor.fill(YAML.replace("action: delay", "action: unknown"));
      await save.click();
      await expect(sheet.getByRole("alert")).toHaveText(
        "invalid: workflow YAML parse error: unknown action",
      );
      await expect(editor).toBeVisible();
      await shot(page, `w5b-refusal-${width}-${theme.name}`);
      for (const phoneWidth of width === 390 ? [390, 375] : [1440]) {
        await page.setViewportSize({ width: phoneWidth, height: 900 });
        await expect
          .poll(async () =>
            sheet.evaluate(
              (element) => element.scrollWidth <= element.clientWidth,
            ),
          )
          .toBe(true);
        expect(
          await page.evaluate(
            () =>
              document.documentElement.scrollWidth <=
              document.documentElement.clientWidth,
          ),
        ).toBe(true);
        for (const control of [
          editor,
          save,
          sheet.getByRole("button", { name: "Cancel", exact: true }),
        ]) {
          const box = await control.boundingBox();
          expect(box).not.toBeNull();
          expect(box?.height).toBeGreaterThanOrEqual(44);
          expect(box?.x).toBeGreaterThanOrEqual(0);
          expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
            phoneWidth + 1,
          );
        }
      }
    });
  }
}
