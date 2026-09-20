import { expect, test } from "@playwright/test";
import { installMockBridge } from "../helpers/bridge";
import { waitForAnimations } from "../helpers/animations";
const A = "a".repeat(64);
const B = "b".repeat(64);
const at = Math.floor(
  new Date(new Date().setHours(12, 0, 0, 0)).getTime() / 1000,
);
const seed = {
  reports: [
    {
      agent: A,
      at,
      input: "9000000",
      output: "1000000",
      total: "10000000",
      cost: 15.5,
      provider: "Anthropic",
      account: "Claude Max · personal",
      accountConfirmed: true,
      model: "Claude Sonnet",
      tier: "Standard",
    },
    {
      agent: B,
      at,
      input: "18000000",
      output: "2000000",
      total: "20000000",
      cost: 22.5,
      provider: "OpenAI",
      account: "ChatGPT Pro",
      model: "GPT",
      tier: "Fast",
    },
  ],
};
test("one many all none filter every analytics dimension and survive reload", async ({
  page,
}) => {
  await installMockBridge(page, { usageAnalytics: seed });
  await page.goto("/#/agents/usage");
  await expect(page.getByTestId("usage-total")).toHaveText("30.0M");
  await page.getByRole("button", { name: "Filter by agents" }).click();
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByText("No agents selected.")).toBeVisible();
  await page.getByRole("button", { name: "Filter by agents" }).click();
  await page.getByRole("checkbox").first().check();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("usage-total")).toHaveText("10.0M");
  await expect(page.getByTestId("usage-cost")).toHaveText(
    "Wire $15.50 · Manifest —",
  );
  await expect(
    page
      .getByRole("region", { name: "Provider breakdown", exact: true })
      .getByText("OpenAI", { exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("usage-total")).toHaveText("10.0M");
  await page.getByRole("button", { name: "Filter by agents" }).click();
  await page.getByRole("button", { name: "Select all", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("usage-total")).toHaveText("30.0M");
});
test("custom validation range URL sort search and export", async ({ page }) => {
  await installMockBridge(page, { usageAnalytics: seed });
  await page.goto("/#/agents/usage");
  await page.getByRole("button", { name: "7D", exact: true }).click();
  await expect(page).toHaveURL(/range=7D/);
  await page.getByRole("button", { name: "Custom", exact: true }).click();
  await page.getByLabel("Start date").fill("2026-09-20");
  await page.getByLabel("End date").fill("2026-09-19");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("start on or before");
  await page.getByRole("button", { name: "30D", exact: true }).click();
  const table = page.getByRole("region", {
    name: "Provider breakdown",
    exact: true,
  });
  await expect(table.locator("tbody th").first()).toHaveText("OpenAI");
  await table.getByRole("button", { name: "Total", exact: true }).click();
  await expect(table.locator("tbody th").first()).toHaveText("Anthropic");
  await table.getByRole("textbox").fill("OpenAI");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV" }).click();
  expect((await download).suggestedFilename()).toBe("buzz-usage.csv");
});
test("empty disabled unknown and retry states remain truthful", async ({
  page,
}) => {
  await installMockBridge(page, {
    usageAnalytics: {
      ...seed,
      collectionEnabled: false,
      reports: [{ agent: A, at, input: null, output: null, cost: null }],
    },
  });
  await page.goto("/#/agents/usage");
  await expect(page.getByText("Usage collection is disabled.")).toBeVisible();
  await expect(page.getByTestId("usage-total")).toHaveText("—");
  await expect(page.getByTestId("usage-cost")).toHaveText(
    "Wire — · Manifest —",
  );
});
for (const width of [375, 768, 1024, 1440, 2560]) {
  test(`responsive reference screenshot ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1032 });
    await installMockBridge(page, { usageAnalytics: seed });
    await page.goto("/#/agents/usage");
    await expect(page.getByTestId("usage-total")).toHaveText("30.0M");
    await waitForAnimations(page);
    expect(
      await page
        .getByTestId("agent-usage-page")
        .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/agent-usage/usage-${width}.png`,
      fullPage: true,
    });
  });
}

/** Elements whose text colour comes from one of the three usage dimension
 *  tokens. Named so a failure says which value is unreadable, not just that
 *  "a ratio was low". */
const CONTRAST_SAMPLES = [
  [
    "Performance band value (--usage-output)",
    ".usage-summary-band:nth-child(2) dd",
  ],
  [
    "Highlights band value (--usage-input)",
    ".usage-summary-band:nth-child(3) dd",
  ],
  ["Est. cost value (--usage-cost)", ".usage-kpi.usage-cost strong"],
] as const;

for (const theme of ["light", "dark"]) {
  test(`theme ${theme}, maximum text zoom and reduced motion`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1032 });
    // `colorScheme` is emulated as well as the stored theme: the provider falls
    // back to following the OS scheme whenever no theme has been stored, so
    // without this the "light" case can render dark on a dark-scheme host and
    // the light palette never gets measured at all.
    await page.emulateMedia({
      reducedMotion: "reduce",
      colorScheme: theme === "light" ? "light" : "dark",
    });
    await page.addInitScript(
      (value) => {
        localStorage.setItem("buzz-theme", value);
        localStorage.setItem("buzz:text-scale", "1.5");
      },
      theme === "light" ? "buzz" : "buzz-dark",
    );
    await installMockBridge(page, { usageAnalytics: seed });
    await page.goto("/#/agents/usage");
    await expect(page.getByTestId("usage-total")).toHaveText("30.0M");
    await expect
      .poll(() =>
        page.evaluate(
          () => getComputedStyle(document.documentElement).fontSize,
        ),
      )
      .toBe("24px");
    await waitForAnimations(page);

    // Prove which theme actually rendered, then prove its dimension colours are
    // legible on it. Asserting only geometry (as this test once did) passes
    // identically in both themes and cannot fail on a colour regression.
    const measured = await page.evaluate(
      (samples) => {
        const parse = (value: string): [number, number, number] => {
          const hex = value.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
          if (hex) {
            const digits =
              hex[1].length === 3
                ? [...hex[1]].map((d) => d + d).join("")
                : hex[1];
            return [0, 2, 4].map((i) =>
              parseInt(digits.slice(i, i + 2), 16),
            ) as [number, number, number];
          }
          const rgb = value.match(/\d+(\.\d+)?/g) ?? [];
          return [Number(rgb[0]), Number(rgb[1]), Number(rgb[2])];
        };
        const luminance = (channels: [number, number, number]) => {
          const [r, g, b] = channels.map((channel) => {
            const unit = channel / 255;
            return unit <= 0.04045
              ? unit / 12.92
              : ((unit + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const contrast = (a: string, b: string) => {
          const [high, low] = [luminance(parse(a)), luminance(parse(b))].sort(
            (x, y) => y - x,
          );
          return (high + 0.05) / (low + 0.05);
        };
        // The colour actually behind the text: the nearest ancestor with a
        // non-transparent background. Measuring the element's own card would
        // report `rgba(0, 0, 0, 0)` and silently compare against black.
        const backdrop = (element: HTMLElement): string => {
          for (
            let node: HTMLElement | null = element;
            node;
            node = node.parentElement
          ) {
            const color = getComputedStyle(node).backgroundColor;
            const alpha = color.match(/rgba?\([^)]*,\s*([\d.]+)\)/);
            if (
              color &&
              color !== "transparent" &&
              (!alpha || Number(alpha[1]) > 0)
            )
              return color;
          }
          return "rgb(255, 255, 255)";
        };
        const surface = backdrop(
          document.querySelector(".usage-summary-band dd") as HTMLElement,
        );
        return {
          surface,
          surfaceLuminance: luminance(parse(surface)),
          ratios: samples.map(([label, selector]) => {
            const element = document.querySelector(
              selector,
            ) as HTMLElement | null;
            return {
              label,
              found: element !== null,
              color: element ? getComputedStyle(element).color : null,
              ratio: element
                ? contrast(getComputedStyle(element).color, backdrop(element))
                : null,
            };
          }),
        };
      },
      CONTRAST_SAMPLES as unknown as [string, string][],
    );

    // Guard against a vacuous pass: every sample must exist and be measured.
    expect(measured.ratios).toHaveLength(3);
    for (const sample of measured.ratios) {
      expect(sample.found, `${sample.label} is missing from the page`).toBe(
        true,
      );
    }
    // The theme-discriminating fact. Without it the "light" case passes
    // identically when a dark theme renders, which is how three sub-AA light
    // values shipped under a green test.
    if (theme === "light") {
      expect(measured.surfaceLuminance).toBeGreaterThan(0.9);
    } else {
      expect(measured.surfaceLuminance).toBeLessThan(0.1);
    }
    for (const sample of measured.ratios) {
      expect(
        sample.ratio,
        `${sample.label} renders ${sample.color} on ${measured.surface} = ${sample.ratio?.toFixed(2)}:1, below WCAG AA 4.5:1`,
      ).toBeGreaterThanOrEqual(4.5);
    }

    expect(
      await page
        .getByTestId("agent-usage-page")
        .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/agent-usage/usage-${theme}-zoom.png`,
      fullPage: true,
    });
    const firstBar = page.locator(".usage-bar").first();
    await firstBar.focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".usage-bar").nth(1)).toBeFocused();
  });
}

/** Surfaces on the analytics page whose colour must actually resolve at
 *  runtime, and the theme token each one reads.
 *
 *  The theme tokens hold bare HSL triplets (`--card: 0 0% 100.0%`), so a
 *  declaration written `background: var(--card)` is *invalid*: the browser
 *  discards it and the property falls back to its initial value, which for a
 *  background is transparent. Nothing throws, no other assertion notices, and
 *  the page renders with no card surfaces, no borders and no muted panels at
 *  all. Every reference has to be `hsl(var(--token))`.
 *
 *  The three `--usage-*` dimension tokens are the opposite case — they hold
 *  full hex colours declared in `usage.css` itself, so wrapping *those* in
 *  `hsl()` is what would break them. The last sample pins one unwrapped.
 */
const SURFACE_SAMPLES = [
  ["Analytics card surface (--card)", ".usage-card", "backgroundColor"],
  ["Analytics card border (--border)", ".usage-card", "borderTopColor"],
  ["Page surface (--background)", ".usage-page", "backgroundColor"],
  [
    "Provider share chip surface (--muted)",
    ".usage-provider-shares > span",
    "backgroundColor",
  ],
  [
    "Input token bar fill (--usage-input)",
    ".usage-bar-input",
    "backgroundColor",
  ],
] as const;

/** Hardcoded, never read back off the token it pins. Stable because the
 *  dimension colours are hex literals in `usage.css` rather than palette
 *  values derived at runtime. */
const EXPECTED_DIMENSION_FILL: Record<string, string> = {
  light: "rgb(195, 52, 80)",
  dark: "rgb(240, 100, 121)",
};

for (const theme of ["light", "dark"]) {
  test(`theme ${theme}, every themed surface resolves to a real colour`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1032 });
    await page.emulateMedia({
      colorScheme: theme === "light" ? "light" : "dark",
    });
    await page.addInitScript(
      (value) => {
        localStorage.setItem("buzz-theme", value);
      },
      theme === "light" ? "buzz" : "buzz-dark",
    );
    await installMockBridge(page, { usageAnalytics: seed });
    await page.goto("/#/agents/usage");
    await expect(page.getByTestId("usage-total")).toHaveText("30.0M");
    await waitForAnimations(page);

    const measured = await page.evaluate(
      (samples: [string, string, string][]) => {
        const luminance = (value: string) => {
          const [r, g, b] = (value.match(/\d+(\.\d+)?/g) ?? [])
            .slice(0, 3)
            .map((channel) => {
              const unit = Number(channel) / 255;
              return unit <= 0.04045
                ? unit / 12.92
                : ((unit + 0.055) / 1.055) ** 2.4;
            });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        return samples.map(([label, selector, property]) => {
          const element = document.querySelector(selector);
          const value = element
            ? (getComputedStyle(element)[
                property as "backgroundColor"
              ] as string)
            : null;
          return {
            label,
            selector,
            value,
            luminance: value === null ? null : luminance(value),
          };
        });
      },
      SURFACE_SAMPLES as unknown as [string, string, string][],
    );

    // Guard the harness before trusting it: a selector that stopped matching
    // would contribute no measurement and the loops below would pass vacuously.
    expect(measured).toHaveLength(SURFACE_SAMPLES.length);
    for (const sample of measured) {
      expect(
        sample.value,
        `${sample.selector} is missing from the page, so ${sample.label} was never measured`,
      ).not.toBeNull();
    }

    // The defect's exact signature, and the assertion that fails when a theme
    // token is consumed bare: the declaration is dropped and the property sits
    // at its initial value.
    for (const sample of measured) {
      expect(
        sample.value,
        `${sample.label} on ${sample.selector} computed to ${sample.value} — the declaration was discarded, so the surface does not render`,
      ).not.toMatch(/^(transparent|rgba\(\s*0,\s*0,\s*0,\s*0\s*\))$/);
    }

    // Theme-discriminating. Without it the light case passes identically when
    // the dark palette renders, so a surface reading the wrong token would go
    // unnoticed. Bands rather than exact values, because the Buzz palettes are
    // derived from the bundled GitHub Light / GitHub Dark themes at runtime.
    for (const sample of measured.slice(0, 4)) {
      if (theme === "light") {
        expect(
          sample.luminance,
          `${sample.label} rendered ${sample.value}, too dark for the light theme`,
        ).toBeGreaterThan(0.6);
      } else {
        expect(
          sample.luminance,
          `${sample.label} rendered ${sample.value}, too light for the dark theme`,
        ).toBeLessThan(0.25);
      }
    }

    const fill = measured[measured.length - 1];
    expect(
      fill.value,
      `${fill.label} computed to ${fill.value}; the dimension tokens are hex colours and must stay unwrapped`,
    ).toBe(EXPECTED_DIMENSION_FILL[theme]);
  });
}

test("loading and error states expose retry without invented metrics", async ({
  page,
}) => {
  await installMockBridge(page, {
    usageAnalytics: { error: "Archive temporarily unavailable", delayMs: 300 },
  });
  await page.goto("/#/agents/usage");
  await expect(page.getByText("Loading your usage reports…")).toBeVisible();
  await expect(page.getByRole("alert")).toContainText(
    "Archive temporarily unavailable",
  );
  await expect(page.getByTestId("usage-total")).toHaveCount(0);
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Usage could not be loaded.",
  );
});

test("back and forward restore date and agent selection", async ({ page }) => {
  await installMockBridge(page, { usageAnalytics: seed });
  await page.goto(`/#/agents/usage?agents=${A}&range=7D`);
  await expect(page.getByTestId("usage-total")).toHaveText("10.0M");
  await page.getByRole("button", { name: "90D", exact: true }).click();
  await expect(page).toHaveURL(/range=90D/);
  await page.goBack();
  await expect(
    page.getByRole("button", { name: "7D", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("usage-total")).toHaveText("10.0M");
  await page.goForward();
  await expect(
    page.getByRole("button", { name: "90D", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("a seeded account reads as provisional until the owner confirms it", async ({
  page,
}) => {
  await installMockBridge(page, { usageAnalytics: seed });
  await page.goto("/#/agents/usage");
  const table = page.getByRole("region", {
    name: "Account breakdown",
    exact: true,
  });
  // `ChatGPT Pro` was seeded (no accountConfirmed in the fixture);
  // `Claude Max · personal` was confirmed. They must not read alike.
  await expect(
    table.getByRole("rowheader", {
      name: /ChatGPT Pro · seeded — unconfirmed/,
    }),
  ).toBeVisible();
  await expect(
    table.getByRole("rowheader", { name: "Claude Max · personal" }),
  ).toBeVisible();
  await expect(table.getByText("Claude Max · personal · seeded")).toHaveCount(
    0,
  );
  await expect(
    page.getByText(/Account identity confirmed for 1 of 2 attributed turns/),
  ).toBeVisible();

  const editor = page.getByRole("region", {
    name: "Accounts & subscriptions",
    exact: true,
  });
  const provisional = editor.locator("li[data-confirmed='false']");
  await expect(provisional).toHaveCount(1);
  await expect(provisional).toContainText("seeded — unconfirmed");

  await provisional.getByRole("button", { name: "Confirm" }).click();
  await editor.getByLabel("Subscription name").fill("ChatGPT Pro (work)");
  await editor.getByLabel("Account ID").fill("chatgpt-pro-work");
  await editor.getByLabel("Provider").fill("openai");
  await editor.getByRole("button", { name: "Confirm" }).click();

  await expect(editor.locator("li[data-confirmed='false']")).toHaveCount(0);
  await expect(
    editor.locator("li[data-confirmed='true']").filter({
      hasText: "ChatGPT Pro (work)",
    }),
  ).toContainText("provider openai");
  // The archived reports are unchanged until those agents restart, so the
  // dashboard's own coverage must NOT claim the new label retroactively.
  await expect(
    page.getByText(/Account identity confirmed for 1 of 2 attributed turns/),
  ).toBeVisible();
});
