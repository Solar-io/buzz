import { expect, test } from "@playwright/test";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";

import { publishAs, type UnsignedTemplate } from "./helpers/relaySeed";
import { signIn } from "./helpers/signIn";

/**
 * Scheduled wakes collapse in the channel timeline (Sam's 2026-09-17
 * "collapsed notifications" ruling).
 *
 * The unit suite pins the predicate; only this instrument can catch the
 * failure mode that matters — the row wiring being dead (predicate fine,
 * MessageRow never branching) — because nothing else renders the real
 * timeline from real relay events. Requires the build to carry
 * VITE_WAKE_SERVICE_PUBKEYS = the service key below, mirroring how
 * production pins the buzz-services identity.
 *
 * Stage, over one authenticated socket per identity (see relaySeed):
 * owner creates a private channel and admits the service identity; the
 * service identity publishes its profile and the wake ping (kind 9, the
 * exact shape jobs/reminders.ts fires); the owner posts a control message
 * that must NOT collapse.
 *
 * Requires `E2E_RELAY_WS` + a build whose VITE_RELAY_URL points at it —
 * same contract as huddle.spec.ts, skips rather than passing on nothing.
 */

const RELAY_WS = process.env.E2E_RELAY_WS ?? "";

/** Deterministic scratch key standing in for BUZZ_SERVICES_KEY — pinned so
 * the build's VITE_WAKE_SERVICE_PUBKEYS and the signer can never drift.
 * ("0e2e" × 16: 32 bytes, valid hex, obviously synthetic.) */
const SERVICE_SECRET = Uint8Array.from(
  Buffer.from("0e2e".repeat(16), "hex"),
);
const SERVICE_PUBKEY = getPublicKey(SERVICE_SECRET);

const WAKE_TEXT = [
  "continue: post-restart verify (2nd check).",
  "Pools still 9/16 14:43 — re-check at the next tick, then rebook.",
].join("\n");
const CONTROL_TEXT = "control message from a member — this row stays expanded";

test.describe("scheduled wake collapsing", () => {
  test.skip(
    !RELAY_WS,
    "E2E_RELAY_WS unset — needs a scratch relay (see huddle.spec.ts header)",
  );

  let channelId: string;
  let ownerSecret: Uint8Array;

  test.beforeAll(async () => {
    ownerSecret = generateSecretKey();
    channelId = crypto.randomUUID();
    const owner = getPublicKey(ownerSecret);
    const channel: UnsignedTemplate[] = [
      {
        kind: 9007,
        tags: [
          ["h", channelId],
          ["name", `wake-e2e-${channelId.slice(0, 6)}`],
          ["visibility", "private"],
        ],
        content: "",
      },
      // Admit the service identity so its kind-9 passes membership gates.
      {
        kind: 9000,
        tags: [
          ["h", channelId],
          ["p", SERVICE_PUBKEY.toLowerCase()],
        ],
        content: "",
      },
      // The control message rides the owner's own socket, after the admits.
      {
        kind: 9,
        tags: [["h", channelId]],
        content: CONTROL_TEXT,
      },
    ];
    await publishAs(RELAY_WS, ownerSecret, channel);
    await publishAs(RELAY_WS, SERVICE_SECRET, [
      {
        kind: 0,
        tags: [],
        content: JSON.stringify({ name: "Buzz Services" }),
      },
      {
        kind: 9,
        tags: [
          ["h", channelId],
          ["p", owner.toLowerCase()],
        ],
        content: WAKE_TEXT,
      },
    ]);
  });

  test("a wake ping renders as one collapsed line and expands verbatim", async ({
    page,
  }) => {
    // Sign in AT the channel URL (the huddle spec's pattern): the enrolled
    // shell mounts straight into the seeded channel.
    await signIn(page, `/repos?c=${channelId}`, ownerSecret);
    const wake = page.getByTestId("scheduled-wake-toggle");
    await expect(wake).toBeVisible();
    // Collapsed: the preview is the squeezed FIRST line — the second line
    // never leaks into the row.
    await expect(page.getByTestId("scheduled-wake-preview")).toHaveText(
      "continue: post-restart verify (2nd check).",
    );
    await expect(page.getByTestId("scheduled-wake-body")).toHaveCount(0);

    await wake.click();
    await expect(page.getByTestId("scheduled-wake-body")).toBeVisible();
    // Verbatim, pre-wrap: both lines, exactly as fired.
    await expect(page.getByTestId("scheduled-wake-body")).toHaveText(WAKE_TEXT);

    await wake.click();
    await expect(page.getByTestId("scheduled-wake-body")).toHaveCount(0);
  });

  test("a member message in the same channel does not collapse", async ({
    page,
  }) => {
    await signIn(page, `/repos?c=${channelId}`, ownerSecret);
    const control = page.getByText(CONTROL_TEXT);
    await expect(control).toBeVisible();
    // The control row must not contain a wake toggle.
    await expect(
      control.locator("xpath=ancestor::div[contains(@data-testid,'message-row-')]"),
    ).not.toContainText("Scheduled wake");
  });
});
