import { expect, test } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";
import * as nip44 from "nostr-tools/nip44";
import { mkdirSync } from "node:fs";
import { installMockRelay, mockEvent } from "./helpers/mockRelay";
import { signIn } from "./helpers/signIn";

test("P0 presence locks offline controls, recovers, and handles old catalogs at desktop and phone widths", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const key = new Uint8Array(32).fill(101); // disposable test identity only
  const owner = getPublicKey(key);
  const agent = "aa".repeat(32);
  const conversation = nip44.v2.utils.getConversationKey(key, owner);
  let responding = true;
  const commands: Array<{
    action: string;
    requires?: string[];
    target?: string;
    requestId: string;
  }> = [];
  const now = Math.floor(Date.now() / 1000);
  const catalog = (version: number, stamp: number) =>
    mockEvent({
      id: String(stamp).padStart(64, "0"),
      pubkey: owner,
      kind: 30180,
      tags: [["d", "crichton.local"]],
      created_at: stamp,
      content: JSON.stringify({
        format: "buzz-desktop-catalog",
        version,
        machine: "crichton.local",
        agents: [agent],
        harnesses: [],
        updated_at: stamp,
        caps: ["ping", "ack.result", "requires", "fresh"],
      }),
    });
  const relay = await installMockRelay(
    page,
    [
      catalog(5, now),
      mockEvent({
        id: "bb".repeat(32),
        pubkey: owner,
        kind: 30177,
        tags: [["d", agent]],
        content: JSON.stringify({
          name: "P0 Test Agent",
          system_prompt: "Disposable test agent",
          model: "test-model",
          respond_to: "owner-only",
        }),
      }),
    ],
    {
      onPublish: (event, handle) => {
        if (event.kind !== 24201) return;
        const command = JSON.parse(
          nip44.v2.decrypt(event.content, conversation),
        );
        commands.push(command);
        if (command.action !== "ping" || !responding) return;
        handle.push(
          mockEvent({
            id: String(commands.length + 500).padStart(64, "0"),
            pubkey: owner,
            kind: 24202,
            content: nip44.v2.encrypt(
              JSON.stringify({
                type: "agent_admin_ack",
                requestId: command.requestId,
                ok: true,
                result: {
                  catalogVersion: 5,
                  caps: ["ping", "ack.result", "requires", "fresh"],
                  machine: "crichton.local",
                  now: new Date().toISOString(),
                },
              }),
              conversation,
            ),
          }),
        );
      },
    },
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await signIn(page, "/repos", key);
  await expect(page.getByTestId("channel-sidebar")).toBeVisible();
  await page.clock.install();
  await page.goto("/repos/agents");
  await page.waitForTimeout(500); // hydrate the persisted key before advancing the clock
  await page.clock.runFor(2_001); // mocked relay's no-AUTH grace
  const footer = page.getByTestId("desktop-connection-footer");
  for (
    let attempt = 0;
    attempt < 20 && (await footer.count()) === 0;
    attempt++
  ) {
    await page.clock.runFor(1_000);
    await page.waitForTimeout(100);
  }
  await expect(footer).toBeVisible();
  await expect(footer).toContainText("online");
  const onlineColor = await footer
    .locator("div")
    .first()
    .evaluate((element) => getComputedStyle(element).color);
  expect(commands.length).toBeGreaterThan(0);
  expect(commands[0].requires).toEqual(["ping"]);
  expect(commands[0].target).toBe("crichton.local");
  await page.getByRole("button", { name: /P0 Test Agent/ }).click();
  const start = page.getByRole("button", { name: "Start", exact: true });
  await expect(start).toBeEnabled();
  responding = false;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.clock.runFor(40_001);
  await expect(footer).toContainText("offline");
  expect(
    (await footer
      .locator("div")
      .first()
      .evaluate((element) => getComputedStyle(element).color)) === onlineColor,
  ).toBe(false);
  await expect(start).toBeDisabled();
  await expect(
    page.getByText("Needs the desktop", { exact: false }),
  ).toBeVisible();
  const mutationsBefore = commands.filter(
    (command) => command.action !== "ping",
  ).length;
  await start.evaluate((element: HTMLButtonElement) => element.click());
  expect(commands.filter((command) => command.action !== "ping")).toHaveLength(
    mutationsBefore,
  );
  const shots = process.env.SHOTS_DIR;
  if (shots) {
    mkdirSync(shots, { recursive: true });
    await page.screenshot({
      path: `${shots}/p0-offline-1440.png`,
      fullPage: true,
    });
  }
  responding = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(footer).toContainText("online");
  await expect(start).toBeEnabled();
  relay.push(catalog(4, now + 1));
  await expect(footer).toContainText("status unknown — update Buzz Desktop");
  await expect(start).toBeDisabled();
  relay.push(catalog(5, now + 2));
  await expect(footer).toContainText("online");

  // Phone acceptance uses an iframe in the claimed desktop tab. Resizing the
  // shared Brave window would disturb other agents using it.
  await page.evaluate(() => {
    const iframe = document.createElement("iframe");
    iframe.id = "p0-phone";
    iframe.style.cssText =
      "position:fixed;inset:0;width:390px;height:900px;z-index:99999;border:0";
    iframe.src = "/repos/settings?group=agents";
    document.body.appendChild(iframe);
  });
  const phone = page.frameLocator("#p0-phone");
  await expect(phone.getByTestId("desktop-connection-footer")).toContainText(
    "online",
  );
  const overflow = await phone.locator("html").evaluate((element) => ({
    width: element.clientWidth,
    scroll: element.scrollWidth,
  }));
  expect(overflow.width).toBe(390);
  expect(overflow.scroll).toBeLessThanOrEqual(390);
  if (shots)
    await page
      .locator("#p0-phone")
      .screenshot({ path: `${shots}/p0-online-390.png` });
  responding = false;
  await phone
    .locator("body")
    .evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.clock.runFor(40_001);
  await expect(phone.getByTestId("desktop-connection-footer")).toContainText(
    "offline",
  );
  expect(
    await phone.locator("html").evaluate((element) => element.scrollWidth),
  ).toBeLessThanOrEqual(390);
  if (shots)
    await page
      .locator("#p0-phone")
      .screenshot({ path: `${shots}/p0-offline-390.png` });
  responding = true;
  await phone
    .locator("body")
    .evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(phone.getByTestId("desktop-connection-footer")).toContainText(
    "online",
  );
  await page.locator("#p0-phone").evaluate((element: HTMLIFrameElement) => {
    element.style.width = "375px";
  });
  expect(
    await phone.locator("html").evaluate((element) => element.scrollWidth),
  ).toBeLessThanOrEqual(375);
  await page.locator("#p0-phone").evaluate((element) => element.remove());
  if (shots)
    await page.screenshot({
      path: `${shots}/p0-online-1440.png`,
      fullPage: true,
    });
  await page.goto("/repos/settings?group=appearance");
  const beforeUnmount = commands.length;
  await page.clock.runFor(90_000);
  expect(commands).toHaveLength(beforeUnmount);
  expect(errors).toEqual([]);
});
