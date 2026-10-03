import { readFileSync } from "node:fs";
import { expect } from "@playwright/test";
import { test } from "./helpers/agentBraveTest";
import { openShell, shot } from "./helpers/shellPage";

const PNG = readFileSync(
  new URL(
    "../../../desktop/tests/fixtures/github-pr-5629-og.png",
    import.meta.url,
  ),
);

for (const [theme, width] of [
  ["buzz", 1440],
  ["buzz-dark", 390],
] as const) {
  test(`item picker, paste, drop and signed detail media ${theme} ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const { relay } = await openShell(page, {
      theme,
      path: () => (width < 768 ? "/repos?view=work" : "/repos?view=items"),
      fixture: { phase2: true },
      relay: { onPublish: (event, relay) => relay.push(event) },
    });
    if (width < 768) {
      await page
        .getByTestId("phone-tab-bar")
        .getByRole("button", { name: "More" })
        .click();
      await page
        .getByTestId("phone-more-sheet")
        .getByRole("button", { name: "Items" })
        .click();
    }
    let putCount = 0;
    let getCount = 0;
    let release: () => void = () => {};
    const uploadWait = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/upload", async (route) => {
      expect(route.request().method()).toBe("PUT");
      expect(route.request().headers().authorization).toMatch(/^Nostr /);
      expect(route.request().postDataBuffer()?.length).toBeGreaterThan(0);
      putCount += 1;
      if (putCount === 1) await uploadWait;
      const type = route.request().headers()["content-type"];
      await route.fulfill({
        json: {
          url: `${new URL(page.url()).origin}/media/evidence-${putCount}.${type.startsWith("image/") ? "png" : "txt"}`,
          sha256: "a".repeat(64),
          type,
          size: 10,
        },
      });
    });
    await page.route("**/media/evidence-*", async (route) => {
      expect(route.request().headers().authorization).toMatch(/^Nostr /);
      getCount += 1;
      await route.fulfill({ contentType: "image/png", body: PNG });
    });
    await page
      .getByRole("button", {
        name: width < 768 ? "Add" : "Add item",
        exact: true,
      })
      .click();
    const dialog = page.getByTestId("add-item-dialog");
    await dialog
      .getByRole("textbox", { name: "Title", exact: true })
      .fill(`Attachment acceptance ${theme}`);
    const description = dialog.getByRole("textbox", { name: /^Description/ });
    await description.fill("Before after");
    await description.evaluate((input: HTMLTextAreaElement) =>
      input.setSelectionRange(6, 6),
    );
    const chooser = page.waitForEvent("filechooser");
    await dialog.getByRole("button", { name: "Attach", exact: true }).click();
    await (await chooser).setFiles({
      name: "button.png",
      mimeType: "image/png",
      buffer: PNG,
    });
    await expect(
      dialog.getByRole("button", { name: "Uploading…" }),
    ).toBeDisabled();
    await expect.poll(() => putCount).toBe(1);
    release();
    await expect(description).toHaveValue(/Before\n!\[button.png\].*\n after/);
    await description.evaluate(
      (input: HTMLTextAreaElement, bytes) => {
        const transfer = new DataTransfer();
        transfer.items.add(
          new File([Uint8Array.from(bytes)], "pasted.png", {
            type: "image/png",
          }),
        );
        input.setSelectionRange(input.value.length, input.value.length);
        input.dispatchEvent(
          new ClipboardEvent("paste", {
            clipboardData: transfer,
            bubbles: true,
            cancelable: true,
          }),
        );
      },
      [...PNG],
    );
    await expect(description).toHaveValue(/!\[pasted.png\]/);
    await page.getByTestId("item-body-editor").evaluate((target) => {
      const transfer = new DataTransfer();
      transfer.items.add(
        new File(["steps to reproduce"], "steps.txt", { type: "text/plain" }),
      );
      target.dispatchEvent(
        new DragEvent("drop", {
          dataTransfer: transfer,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await expect(description).toHaveValue(/\[steps.txt\]/);
    await shot(page, `capture-${theme}-${width}`);
    await dialog.getByRole("button", { name: "File bug", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const event = relay.published.find((event) => event.kind === 30623);
    expect(event).toBeDefined();
    expect(event?.content).toContain("![button.png]");
    expect(event?.content).toContain("![pasted.png]");
    expect(event?.content).toContain("[steps.txt]");
    const itemId = event?.tags.find((entry) => entry[0] === "d")?.[1];
    const row = page.getByTestId(`item-row-${itemId}`);
    await row.getByTestId("item-expand").click();
    const detail = page.getByTestId("item-detail");
    await expect(
      detail.getByRole("img", { name: "button.png", exact: true }),
    ).toBeVisible();
    await expect(
      detail.getByRole("img", { name: "pasted.png", exact: true }),
    ).toBeVisible();
    await expect(detail.getByRole("link", { name: "steps.txt" })).toBeVisible();
    expect(putCount).toBe(3);
    expect(getCount).toBeGreaterThanOrEqual(2);
    expect(
      await detail
        .getByRole("img", { name: "button.png", exact: true })
        .evaluate((image: HTMLImageElement) => image.naturalWidth),
    ).toBeGreaterThan(0);
    await shot(page, `detail-${theme}-${width}`);
    await detail.locator("[data-lightbox-trigger]").first().click();
    await expect(page.getByRole("dialog", { name: /Image:/i })).toBeVisible();
    await shot(page, `lightbox-${theme}-${width}`);
  });
}
