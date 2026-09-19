import assert from "node:assert/strict";
import { test } from "node:test";

const { isCallOver, shouldDispatchJoin } = await import(
  "./huddleCallLifecycle.ts"
);

test("a join is dispatched once the hook renders the requested channel", () => {
  assert.equal(
    shouldDispatchJoin({
      pendingChannelId: "h1",
      hookChannelId: "h1",
      status: "idle",
    }),
    true,
  );
  // The hook still renders the previous (null) channel in the commit that
  // set the target — dialing then is the /huddle/null/audio defect.
  assert.equal(
    shouldDispatchJoin({
      pendingChannelId: "h1",
      hookChannelId: null,
      status: "idle",
    }),
    false,
  );
  assert.equal(
    shouldDispatchJoin({
      pendingChannelId: null,
      hookChannelId: "h1",
      status: "idle",
    }),
    false,
  );
});

test("a failed join (error status) can be retried; a live one cannot be re-dispatched", () => {
  assert.equal(
    shouldDispatchJoin({
      pendingChannelId: "h1",
      hookChannelId: "h1",
      status: "error",
    }),
    true,
  );
  for (const status of ["connecting", "connected", "reconnecting"]) {
    assert.equal(
      shouldDispatchJoin({
        pendingChannelId: "h1",
        hookChannelId: "h1",
        status,
      }),
      false,
      status,
    );
  }
});

test("the call is over only on a live -> idle transition", () => {
  assert.equal(
    isCallOver({
      hasTarget: true,
      previousStatus: "connected",
      status: "idle",
    }),
    true,
  );
  assert.equal(
    isCallOver({
      hasTarget: true,
      previousStatus: "reconnecting",
      status: "idle",
    }),
    true,
  );
});

test("an idle status right after the join was requested is NOT the end of the call (the 2026-09-19 null-channel race)", () => {
  // Same-commit read: the target was just set, join() was just called, the
  // status state is still the idle it was rendered with.
  assert.equal(
    isCallOver({ hasTarget: true, previousStatus: "idle", status: "idle" }),
    false,
  );
  // A start that failed reports error, not idle; and connecting -> idle is
  // not a shape the hook produces, so it must not tear the target down.
  assert.equal(
    isCallOver({
      hasTarget: true,
      previousStatus: "connecting",
      status: "idle",
    }),
    false,
  );
  assert.equal(
    isCallOver({
      hasTarget: true,
      previousStatus: "connected",
      status: "error",
    }),
    false,
  );
  assert.equal(
    isCallOver({
      hasTarget: false,
      previousStatus: "connected",
      status: "idle",
    }),
    false,
  );
});
