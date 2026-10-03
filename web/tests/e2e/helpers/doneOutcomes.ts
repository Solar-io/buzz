import { expect, type Locator, type Page } from "@playwright/test";

import { channelPath, openShell } from "./shellPage";
import { jobHead, lifecycleHead } from "./taskStatusFixture";

/** Check the actual label rectangle against EVERY clipping ancestor and viewport. */
export async function expectPaintedWithinClips(
  outcome: Locator,
  label: string,
) {
  // Scrolling the label itself can horizontally scroll its overflow-hidden
  // headline, hiding the defect that this assertion is meant to catch.
  await outcome.locator("xpath=ancestor::button[1]").scrollIntoViewIfNeeded();
  const geometry = await outcome.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const clips = [
      {
        name: "viewport",
        left: 0,
        top: 0,
        right: innerWidth,
        bottom: innerHeight,
        x: true,
        y: true,
      },
    ];
    for (
      let parent = element.parentElement;
      parent;
      parent = parent.parentElement
    ) {
      const style = getComputedStyle(parent);
      const x = /^(hidden|clip|auto|scroll)$/.test(style.overflowX);
      const y = /^(hidden|clip|auto|scroll)$/.test(style.overflowY);
      if (!x && !y) continue;
      const rect = parent.getBoundingClientRect();
      const left = rect.left + parent.clientLeft;
      const top = rect.top + parent.clientTop;
      clips.push({
        name: `${parent.tagName}.${parent.className}`,
        left,
        top,
        right: left + parent.clientWidth,
        bottom: top + parent.clientHeight,
        x,
        y,
      });
    }
    // A self-truncated label could have a contained box but clipped glyphs.
    const range = document.createRange();
    range.selectNodeContents(element);
    const text = range.getBoundingClientRect();
    return {
      box: {
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        width: box.width,
        height: box.height,
      },
      text: {
        left: text.left,
        right: text.right,
        top: text.top,
        bottom: text.bottom,
      },
      clips,
    };
  });
  expect(geometry.box.width, `${label}: nonempty painted box`).toBeGreaterThan(
    0,
  );
  expect(geometry.box.height, `${label}: nonempty painted box`).toBeGreaterThan(
    0,
  );
  expect(
    geometry.clips.length,
    `${label}: actual clipping ancestor`,
  ).toBeGreaterThan(1);
  for (const clip of geometry.clips) {
    for (const rect of [geometry.box, geometry.text]) {
      if (clip.x) {
        expect
          .soft(rect.left, `${label}: left inside ${clip.name}`)
          .toBeGreaterThanOrEqual(clip.left - 0.5);
        expect
          .soft(rect.right, `${label}: right inside ${clip.name}`)
          .toBeLessThanOrEqual(clip.right + 0.5);
      }
      if (clip.y) {
        expect
          .soft(rect.top, `${label}: top inside ${clip.name}`)
          .toBeGreaterThanOrEqual(clip.top - 0.5);
        expect
          .soft(rect.bottom, `${label}: bottom inside ${clip.name}`)
          .toBeLessThanOrEqual(clip.bottom + 0.5);
      }
    }
  }
}

/** Long real-world names; four abnormal jobs, an untitled failed turn and quiet completions. */
export async function openDoneOutcomes(
  page: Page,
  theme: string,
  surface: "rail" | "full" | "phone",
) {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const at = Math.floor(Date.now() / 1000);
  const { fixture } = await openShell(page, {
    theme,
    path: surface === "rail" ? channelPath("ops") : () => "/repos?view=work",
    extra: (base) => {
      // Keep channel/profile/registry transport, removing unrelated work so
      // every outcome can be photographed together at the ordinary rail size.
      base.events = base.events.filter((event) =>
        [0, 30177, 39000, 39002].includes(event.kind),
      );
      const agent = base.agents.cereal.pubkey;
      const channel = base.channels.ops;
      for (const event of base.events) {
        if (
          (event.kind === 0 && event.pubkey === agent) ||
          (event.kind === 30177 &&
            event.tags.some((tag) => tag[0] === "d" && tag[1] === agent))
        ) {
          event.content = JSON.stringify({
            ...JSON.parse(event.content),
            name: "Independent Release QA Seat",
            display_name: "Independent Release QA Seat",
          });
        }
        if (
          event.kind === 39000 &&
          event.tags.some((tag) => tag[0] === "d" && tag[1] === channel)
        ) {
          event.tags = event.tags.map((tag) =>
            tag[0] === "name"
              ? ["name", "Independent Job QA and Release Engineering"]
              : tag,
          );
        }
      }
      return [
        jobHead(agent, channel, "failed", "error", at - 1, at - 600, {
          role: "coder",
          model: "gpt-6.1-sol",
          title: "Validate release worker",
          reason: "worker-failed",
        }),
        jobHead(agent, channel, "timeout", "error", at - 2, at - 600, {
          role: "coder",
          model: "gpt-6.1-sol",
          title: "Check deployment timeout",
          reason: "timeout",
        }),
        jobHead(agent, channel, "cancelled", "cancelled", at - 3, at - 600, {
          role: "coder",
          model: "gpt-6.1-sol",
        }),
        jobHead(agent, channel, "dropped", "running", at - 301, at - 600, {
          role: "coder",
          model: "gpt-6.1-sol",
          title: "Recover missing heartbeat",
        }),
        jobHead(agent, channel, "done", "done", at - 4, at - 600, {
          role: "coder",
          model: "gpt-6.1-sol",
          title: "Completed release inventory",
        }),
        lifecycleHead(
          agent,
          channel,
          "failed-turn",
          "error",
          at - 5,
          at - 600,
          "harness-restart",
        ),
        lifecycleHead(
          base.agents.crash.pubkey,
          channel,
          "normal-turn",
          "done",
          at - 6,
          at - 600,
        ),
      ];
    },
  });
  await expect(page.locator("html")).toHaveClass(
    theme === "buzz-dark" ? /\bdark\b/ : /\blight\b/,
  );
  const work = page.getByTestId(surface === "rail" ? "work-rail" : "work-page");
  await expect(work).toBeVisible();
  if (surface !== "rail") {
    await work.getByRole("button", { name: /^Running 0$/ }).click();
  }
  await work.getByRole("button", { name: /Done today\s*7/ }).click();
  await work.getByRole("button", { name: "Show 1 more" }).click();
  const job = (id: string) =>
    work.locator(
      `[data-row-key="job:${fixture.agents.cereal.pubkey}:${fixture.channels.ops}:${id}"]`,
    );
  return {
    work,
    outcomes: [
      { row: job("failed"), label: "error · worker-failed" },
      { row: job("timeout"), label: "error · timeout" },
      { row: job("cancelled"), label: "cancelled" },
      { row: job("dropped"), label: "dropped · no heartbeat" },
      {
        row: work.locator(
          `[data-row-key="${fixture.agents.cereal.pubkey}:failed-turn"]`,
        ),
        label: "error · harness-restart",
      },
    ],
    normalJob: job("done"),
    normalTurn: work.locator(
      `[data-row-key="${fixture.agents.crash.pubkey}:normal-turn"]`,
    ),
    pageErrors,
  };
}
