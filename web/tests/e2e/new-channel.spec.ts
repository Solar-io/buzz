import { expect, test } from "@playwright/test";
import {
  hexId,
  mockEvent,
  type MockEvent,
  type MockRelay,
} from "./helpers/mockRelay";
import { openShell, channelPath, shot } from "./helpers/shellPage";

const tag = (event: MockEvent, key: string) =>
  event.tags.find(([name]) => name === key)?.[1];

// Mirror the relay's metadata readback, deliberately WITHOUT live 39000 fan-out.
// The dialog must use the shell's refresh path before the new view can open.
function materializeChannel(event: MockEvent, relay: MockRelay) {
  if (event.kind !== 9007) return;
  const id = tag(event, "h") as string;
  const ttl = tag(event, "ttl");
  relay.add(
    mockEvent({
      id: hexId(9007, "c"),
      kind: 39000,
      tags: [
        ["d", id],
        ["name", tag(event, "name") as string],
        ["t", tag(event, "channel_type") ?? "stream"],
        ...(tag(event, "visibility") === "private" ? [["private"]] : []),
        ...(ttl
          ? [
              ["ttl", ttl],
              [
                "ttl_deadline",
                new Date(Date.now() + Number(ttl) * 1000).toISOString(),
              ],
            ]
          : []),
      ],
    }),
    mockEvent({
      id: hexId(9002, "c"),
      kind: 39002,
      tags: [
        ["d", id],
        ["p", event.pubkey, "admin"],
      ],
    }),
  );
}

async function createForm(page: Parameters<typeof openShell>[0]) {
  const add = page.getByRole("button", { name: "New channel", exact: true });
  if (!(await add.isVisible())) {
    await page
      .getByRole("button", { name: "Open channels", exact: true })
      .click();
  }
  await add.click();
  return page.getByRole("form", { name: "New channel" });
}

async function noOverflow(
  form: ReturnType<Parameters<typeof openShell>[0]["getByRole"]>,
  width: number,
) {
  await expect(form).toBeVisible();
  const bounds = await form.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      overflow: node.scrollWidth - node.clientWidth,
    };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(width);
  expect(bounds.overflow).toBeLessThanOrEqual(0);
  for (const control of await form
    .locator('button, select, input:not([type="radio"]):not([type="checkbox"])')
    .all()) {
    const box = await control.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
}

for (const width of [1440, 390, 375]) {
  test.describe(`new channel · ${width}`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("dialog creates a forum with 7 days and opens ForumView", async ({
      page,
    }) => {
      const { relay } = await openShell(page, {
        theme: "buzz",
        path: channelPath(),
        relay: { onPublish: materializeChannel },
      });
      const form = await createForm(page);
      await form.getByLabel("Name", { exact: true }).fill("w4-design-forum");
      await form.getByText("Forum", { exact: true }).click();
      await form.getByLabel("Lifetime", { exact: true }).selectOption("604800");
      await noOverflow(form, width);
      await shot(page, `w4-new-forum-${width}`);
      await form.getByRole("button", { name: "Create", exact: true }).click();
      await expect
        .poll(() => relay.published.filter((e) => e.kind === 9007).length)
        .toBe(1);
      const created = relay.published.find((e) => e.kind === 9007) as MockEvent;
      expect(tag(created, "channel_type")).toBe("forum");
      expect(tag(created, "ttl")).toBe("604800");
      expect(tag(created, "visibility")).toBe("private");
      await expect(page).toHaveURL(new RegExp(`c=${tag(created, "h")}`));
      await expect(page.getByTestId("forum-post-list")).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Start a new post", exact: false }),
      ).toBeVisible();
      await shot(page, `w4-created-forum-${width}`);
    });

    test("24 h stream shows expiry and remains reachable in Channels", async ({
      page,
    }) => {
      const { relay, fixture } = await openShell(page, {
        theme: "buzz",
        path: channelPath(),
        relay: { onPublish: materializeChannel },
      });
      const form = await createForm(page);
      await form.getByLabel("Name", { exact: true }).fill("w4-day-channel");
      await form.getByLabel("Lifetime", { exact: true }).selectOption("86400");
      await form.getByRole("button", { name: "Create", exact: true }).click();
      await expect
        .poll(() => relay.published.filter((e) => e.kind === 9007).length)
        .toBe(1);
      const created = relay.published.find((e) => e.kind === 9007) as MockEvent;
      expect(tag(created, "channel_type")).toBe("stream");
      expect(tag(created, "ttl")).toBe("86400");
      const expiry = page.getByTestId("channel-expiry-badge");
      await expect(expiry).toBeVisible();
      await expect(expiry).toHaveText(/^(23h 59m|24h) left$/);
      await shot(page, `w4-created-24h-${width}`);
      const add = page.getByRole("button", {
        name: "New channel",
        exact: true,
      });
      if (!(await add.isVisible()))
        await page
          .getByRole("button", { name: "Open channels", exact: true })
          .click();
      const sidebar = page.getByTestId("channel-sidebar");
      await expect(
        sidebar.getByText("w4-day-channel", { exact: true }),
      ).toBeVisible();
      await sidebar.getByText("flight-path", { exact: true }).click();
      await expect(page).toHaveURL(
        new RegExp(`c=${fixture.channels["flight-path"]}`),
      );
      if (!(await add.isVisible()))
        await page
          .getByRole("button", { name: "Open channels", exact: true })
          .click();
      await sidebar.getByText("w4-day-channel", { exact: true }).click();
      await expect(expiry).toBeVisible();
    });

    test("relay refusal keeps choices; successful creation resets type and lifetime", async ({
      page,
    }) => {
      let refused = false;
      const { relay } = await openShell(page, {
        theme: "buzz",
        path: channelPath(),
        relay: {
          onPublish: materializeChannel,
          rejectPublish: (event) => {
            if (event.kind !== 9007 || refused) return null;
            refused = true;
            return "restricted: test creation refused";
          },
        },
      });
      let form = await createForm(page);
      await form.getByLabel("Name", { exact: true }).fill("w4-retry");
      await form.getByText("Forum", { exact: true }).click();
      await form
        .getByLabel("Lifetime", { exact: true })
        .selectOption("2592000");
      await form.getByRole("button", { name: "Create", exact: true }).click();
      await expect(
        page.getByText("restricted: test creation refused"),
      ).toBeVisible();
      await expect(form).toBeVisible();
      await expect(
        form.getByRole("radio", { name: "Forum", exact: true }),
      ).toBeChecked();
      await expect(form.getByLabel("Lifetime", { exact: true })).toHaveValue(
        "2592000",
      );
      await form.getByRole("button", { name: "Create", exact: true }).click();
      await expect(form).toHaveCount(0);
      form = await createForm(page);
      await expect(
        form.getByRole("radio", { name: "Stream", exact: true }),
      ).toBeChecked();
      await expect(form.getByLabel("Lifetime", { exact: true })).toHaveValue(
        "0",
      );
      expect(relay.published.filter((e) => e.kind === 9007)).toHaveLength(2);
    });
  });
}
