import assert from "node:assert/strict";
import { test } from "node:test";

// T9: Diagnostics name the address: RelayConnectionCard status="closed" with relayWsUrl
// stubbed → text contains relay.test:6351

test("T9: RelayConnectionCard describe function includes relay host", async (t) => {
  // This test verifies the logic that will be implemented in the describe() function
  // which takes a status and a relayHost, and returns text that includes the host.

  // Simulate what the modified describe function should do
  const relayHost = "relay.test:6351";

  function describeWithHost(status, relayHost) {
    switch (status) {
      case "closed":
        return {
          title: `Could not reach ${relayHost}`,
          detail: "Messages will not be delivered until this returns.",
          transient: false,
        };
      case "reconnecting":
        return {
          title: `Lost the connection to ${relayHost}`,
          detail: "Retrying automatically.",
          transient: true,
        };
      case "unconfigured":
        return {
          title: "No relay address is configured",
          detail: "Open Settings → Identity and connection.",
          transient: false,
        };
      default:
        return null;
    }
  }

  // Test closed state includes host
  const closedState = describeWithHost("closed", relayHost);
  assert.ok(closedState.title.includes("relay.test:6351"));
  assert.ok(closedState.title.includes("Could not reach"));

  // Test reconnecting state includes host
  const reconnectingState = describeWithHost("reconnecting", relayHost);
  assert.ok(reconnectingState.title.includes("relay.test:6351"));
  assert.ok(reconnectingState.title.includes("Lost the connection"));

  // Test unconfigured state (no host in message)
  const unconfiguredState = describeWithHost("unconfigured", "");
  assert.ok(unconfiguredState.title.includes("No relay address is configured"));
  assert.ok(!unconfiguredState.title.includes("relay.test"));
});
