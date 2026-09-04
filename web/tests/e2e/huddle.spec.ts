import { expect, test } from "@playwright/test";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { nsecEncode } from "nostr-tools/nip19";

import { publishAs, seedHuddle } from "./helpers/relaySeed";

/**
 * The huddle bar's in-call surfaces, against a REAL relay and a REAL audio
 * room.
 *
 * This is the only instrument that can tell "correct" from "shipped and
 * dead" here. Every one of these controls is gated on the audio room having
 * admitted the viewer, so a unit test can prove the event shapes and still
 * leave a bar that renders nothing — which is exactly the failure mode a
 * feature reached from one place has.
 *
 * Requires a relay: `E2E_RELAY_WS` (e.g. `ws://localhost:6390`) and a build
 * whose `VITE_RELAY_URL` points at the same one. Without it the spec skips
 * rather than passing on a browser that reached nothing.
 *
 * The microphone comes from Chromium's fake device (see the `huddle` project
 * in `playwright.config.ts`); a real grant prompt is not something a headless
 * run can answer.
 *
 * RUN THE RELAY WITH ITS WRITE QUOTA RAISED, or this fails intermittently for
 * a reason that has nothing to do with huddles:
 *
 *   BUZZ_RATE_LIMIT_HUMAN_WS_EVENTS_PER_SEC=200 \
 *   BUZZ_RATE_LIMIT_HUMAN_MESSAGES_PER_MIN=600 \
 *   BUZZ_RATE_LIMIT_HUMAN_API_CALLS_PER_MIN=600
 *
 * The default is 10 WS events per second per human
 * (`default_human_ws`, crates/buzz-auth/src/rate_limit.rs:126) and the shell
 * spends its first seconds opening and closing dozens of REQs, so a publish
 * landing in that window is throttled. The relay answers a throttled write
 * with a NOTICE rather than an OK, which `RelaySession.publish` does not
 * resolve on — it waits out its 15s ack timeout and reports "timed out
 * waiting for the relay". The `notices` assertion below fails loudly instead
 * of leaving that to be re-diagnosed.
 */

const RELAY_WS = process.env.E2E_RELAY_WS ?? "";

test.describe("huddle in-call controls", () => {
  test.skip(
    RELAY_WS === "",
    "set E2E_RELAY_WS (and build with a matching VITE_RELAY_URL) to run",
  );

  test("reactions, agent speech and add-agent are live in a joined huddle", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    // The relay answers a throttled write with a NOTICE, not an OK, so
    // `RelaySession.publish` waits out its 15s ack timeout and reports
    // "timed out waiting for the relay" instead of "rate limited". Surfacing
    // the NOTICE here keeps that from being diagnosed twice.
    const notices: string[] = [];
    page.on("websocket", (ws) => {
      ws.on("framereceived", (frame) => {
        const payload = String(frame.payload);
        if (payload.startsWith('["NOTICE"')) {
          notices.push(payload);
        }
      });
    });

    // Key A is the viewer. Key B is a second huddle member whose reaction has
    // to travel through the relay to reach A's screen. Key C stands in for an
    // agent in A's kind-30177 registry.
    const viewerKey = generateSecretKey();
    const peerKey = generateSecretKey();
    const agentPubkey = getPublicKey(generateSecretKey());

    // The peer joins with role `bot`, so the same key exercises BOTH paths:
    // a reaction any member may send, and a message only a huddle agent's is
    // eligible to be spoken.
    const huddle = await seedHuddle(RELAY_WS, viewerKey, {
      extraBots: [getPublicKey(peerKey)],
      registryAgents: [{ pubkey: agentPubkey, name: "E2E Agent" }],
    });

    // Sign in AT the huddle channel: manual key entry sets no
    // remembered-device key, so a later full navigation drops the session.
    await page.goto(`/repos?c=${huddle.ephemeralChannelId}`);
    await page.getByRole("button", { name: "Enter key manually" }).click();
    await page.getByPlaceholder("nsec1…").fill(nsecEncode(viewerKey));
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByPlaceholder("New passphrase").fill("e2e-passphrase");
    await page.getByPlaceholder("Confirm passphrase").fill("e2e-passphrase");
    await page.getByRole("button", { name: "Finish" }).click();
    await expect(page.getByTestId("channel-sidebar")).toBeVisible();

    // The bar itself: present because the channel carries a ttl.
    const join = page.getByTestId("huddle-join-audio");
    await expect(join).toBeVisible({ timeout: 20_000 });

    // None of the in-call controls exist before the room admits us. Asserting
    // their ABSENCE first is what makes their presence below meaningful.
    await expect(page.getByTestId("huddle-react")).toHaveCount(0);
    await expect(page.getByTestId("huddle-add-agent")).toHaveCount(0);

    await join.click();
    await expect(page.getByTestId("huddle-mute")).toBeVisible({
      timeout: 20_000,
    });

    await expect(page.getByTestId("huddle-react")).toBeVisible();
    await expect(page.getByTestId("huddle-agent-speech")).toBeVisible();
    await expect(page.getByTestId("huddle-add-agent")).toBeVisible();

    // ── A reaction from ANOTHER member, over the wire ────────────────────
    // Not our own optimistic burst: this event is signed by key B, accepted
    // by the relay, fanned out on the ephemeral channel's `h` scope, and
    // decoded by the subscription under test.
    await publishAs(RELAY_WS, peerKey, [
      {
        kind: 24810,
        tags: [
          ["h", huddle.ephemeralChannelId],
          ["reaction", "🎉"],
          ["sender_name", "Remote Member"],
        ],
        content: "🎉",
      },
    ]);
    const burst = page.getByTestId("huddle-reaction-burst");
    await expect(burst).toBeVisible({ timeout: 15_000 });
    await expect(burst).toContainText("Remote Member");
    await expect(burst).toContainText("🎉");

    // ── Sending one ──────────────────────────────────────────────────────
    // A different glyph from the remote burst above, so the assertion cannot
    // be satisfied by the reaction that is already on screen.
    await page.getByTestId("huddle-react").click();
    await page.getByTestId("emoji-grinning").click();
    await expect(page.getByTestId("huddle-reaction-burst")).toContainText("😀");

    // ── Agent speech ─────────────────────────────────────────────────────
    // Headless Chromium ships no voices, so a real `speak()` would resolve
    // through `onerror` and leave nothing to assert. Capturing the call is
    // what proves the selection pipeline REACHES the synthesizer — the one
    // thing a unit test on the classifier cannot tell you.
    await page.evaluate(() => {
      const spoken: string[] = [];
      (window as unknown as { __spoken: string[] }).__spoken = spoken;
      window.speechSynthesis.speak = (utterance: SpeechSynthesisUtterance) => {
        spoken.push(utterance.text);
        utterance.dispatchEvent(new Event("end"));
      };
    });

    const speech = page.getByTestId("huddle-agent-speech");
    await expect(speech).toHaveAttribute("aria-pressed", "false");

    // Nothing is spoken while speech is off, even from a genuine agent.
    await publishAs(RELAY_WS, peerKey, [
      {
        kind: 40002,
        tags: [["h", huddle.ephemeralChannelId]],
        content: "This must not be spoken.",
      },
    ]);
    await page.waitForTimeout(2_000);
    expect(
      await page.evaluate(
        () => (window as unknown as { __spoken: string[] }).__spoken,
      ),
    ).toEqual([]);

    await speech.click();
    await expect(speech).toHaveAttribute("aria-pressed", "true");

    await publishAs(RELAY_WS, peerKey, [
      // A [System] notice: eligible author, eligible kind, eligible channel —
      // and still must not be spoken. Only the content rule can reject it.
      {
        kind: 40002,
        tags: [["h", huddle.ephemeralChannelId]],
        content: "[System] agent restarted",
      },
      {
        kind: 40002,
        tags: [["h", huddle.ephemeralChannelId]],
        content: "Deploy finished cleanly.",
      },
    ]);
    await expect
      .poll(
        async () =>
          await page.evaluate(
            () => (window as unknown as { __spoken: string[] }).__spoken,
          ),
        { timeout: 15_000 },
      )
      .toEqual(["Deploy finished cleanly."]);

    // ── Adding an agent, end to end ──────────────────────────────────────
    await page.getByTestId("huddle-add-agent").click();
    const dialog = page.getByTestId("add-huddle-agent-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("E2E Agent");
    await dialog.getByTestId("add-huddle-agent-row").first().click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    // Reopening proves the round trip: the kind-9000 was accepted, the relay
    // re-signed the channel's kind-39002 snapshot with the agent at role
    // `bot`, and the roster hook read it back. A picker that merely closed
    // would still list the agent here.
    await page.getByTestId("huddle-add-agent").click();
    await expect(page.getByTestId("add-huddle-agent-dialog")).toContainText(
      "Every agent you have is already in this huddle",
      { timeout: 20_000 },
    );

    expect(pageErrors).toEqual([]);
    expect(notices).toEqual([]);
  });
});
