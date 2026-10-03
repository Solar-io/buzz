import { expect } from "@playwright/test";
import { test } from "./helpers/agentBraveTest";
import { mockEvent } from "./helpers/mockRelay";
import { channelPath, openShell } from "./helpers/shellPage";

for (const theme of ["buzz", "buzz-dark"]) {
  test(`agent message details expand and collapse both body shapes · ${theme}`, async ({
    page,
  }) => {
    const id = "de".repeat(32);
    await openShell(page, {
      theme,
      path: channelPath("flight-path"),
      extra: (fixture) => [
        mockEvent({
          id,
          kind: 9,
          pubkey: fixture.agents.crash.pubkey,
          tags: [["h", fixture.channels["flight-path"]]],
          content:
            "✳️ Updates: details browser fixture\n\n" +
            "<details><summary>🌌 Blank-line body</summary>\n\n- first a\n- first b\n\n</details>\n\n" +
            "<details><summary>🌌 Single-node body</summary>\n- second a\n- second b\n</details>",
        }),
      ],
    });
    const message = page.getByTestId(`message-row-${id}`);
    await expect(message).toBeVisible();
    await expect(message.locator("details > summary")).toHaveCount(2);
    await expect(message).not.toContainText("<details>");
    for (const [label, items] of [
      ["🌌 Blank-line body", ["first a", "first b"]],
      ["🌌 Single-node body", ["second a", "second b"]],
    ] as const) {
      const summary = message.locator("summary", { hasText: label });
      const details = summary.locator("..");
      const body = details.locator("ul");
      await expect(details).not.toHaveAttribute("open");
      await expect(body).toBeHidden();
      await expect(body.locator("li")).toHaveText([...items]);
      expect(
        await summary.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            display: style.display,
            cursor: style.cursor,
            marker: style.listStyleType,
          };
        }),
      ).toEqual({
        display: "list-item",
        cursor: "pointer",
        marker: "disclosure-closed",
      });
      await summary.click();
      await expect(details).toHaveAttribute("open", "");
      await expect(body).toBeVisible();
      expect(
        await body.evaluate((element) =>
          Number.parseFloat(getComputedStyle(element).marginTop),
        ),
      ).toBeGreaterThan(0);
      await summary.click();
      await expect(body).toBeHidden();
      // Native summary keyboard activation must work too.
      await summary.focus();
      await page.keyboard.press("Enter");
      await expect(body).toBeVisible();
    }
  });
}
