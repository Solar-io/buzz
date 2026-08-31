import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGENT_MANAGEMENT_REQUEST,
  buildObserverEnvelope,
  updateHasChanges,
  validateDraftText,
} from "./agentDrafts.ts";

test("validateDraftText trims, rejects empty, enforces the cap", () => {
  assert.deepEqual(validateDraftText("  Dade  "), { ok: true, value: "Dade" });
  assert.equal(validateDraftText("   ").ok, false);
  assert.equal(validateDraftText("x".repeat(121)).ok, false);
  assert.deepEqual(validateDraftText("x".repeat(120)), {
    ok: true,
    value: "x".repeat(120),
  });
  // Custom cap (the prompt's 20k limit).
  assert.equal(validateDraftText("x".repeat(20_001), 20_000).ok, false);
  assert.equal(validateDraftText("x".repeat(20_000), 20_000).ok, true);
});

test("buildDraftPayload wraps the request in the observer envelope", () => {
  const json = buildObserverEnvelope(
    {
      type: AGENT_MANAGEMENT_REQUEST,
      action: "create",
      requestId: "req-1",
      request: {
        channelId: "c1",
        displayName: "Dade",
        systemPrompt: "Be cool.",
      },
    },
    "c1",
    "req-1",
    "2026-08-31T16:00:00Z",
  );
  const parsed = JSON.parse(json);
  assert.equal(parsed.kind, AGENT_MANAGEMENT_REQUEST);
  assert.equal(parsed.seq, 0);
  assert.equal(parsed.agentIndex, null);
  assert.equal(parsed.channelId, "c1");
  assert.equal(parsed.payload.type, AGENT_MANAGEMENT_REQUEST);
  assert.equal(parsed.payload.action, "create");
  assert.equal(parsed.payload.requestId, "req-1");
  assert.deepEqual(parsed.payload.request, {
    channelId: "c1",
    displayName: "Dade",
    systemPrompt: "Be cool.",
  });
  // Update payloads serialize optional fields as camelCase keys.
  const update = buildObserverEnvelope(
    {
      type: "switch_model",
      channelId: "c1",
      modelId: "glm-5.3",
      requestId: "req-2",
    },
    "c1",
    "req-2",
    "2026-08-31T16:01:00Z",
  );
  const parsedUpdate = JSON.parse(update);
  assert.equal(parsedUpdate.kind, "switch_model");
  assert.equal(parsedUpdate.payload.modelId, "glm-5.3");
  assert.equal(parsedUpdate.channelId, "c1");
});

test("updateHasChanges requires a real change field", () => {
  assert.equal(updateHasChanges({ channelId: "c1", agentName: "Dade" }), false);
  assert.equal(
    updateHasChanges({ channelId: "c1", agentName: "Dade", model: "glm-5.3" }),
    true,
  );
  assert.equal(
    updateHasChanges({
      channelId: "c1",
      agentName: "Dade",
      respondTo: "anyone",
    }),
    true,
  );
});
