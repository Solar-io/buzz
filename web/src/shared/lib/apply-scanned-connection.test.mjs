import assert from "node:assert/strict";
import { test } from "node:test";

// Lazy-import only when needed to isolate any import-time issues
const getApplyScannedConnection = async () => {
  const mod = await import("./apply-scanned-connection.ts");
  return mod.applyScannedConnection;
};

const getClassifyScannedConnection = async () => {
  const mod = await import("./pairing-link.ts");
  return mod.classifyScannedConnection;
};

// T7: applyScannedConnection with fakes: proper order and cancel handling

test("T7a: applyScannedConnection on first-run writes, no confirm/prepare", async () => {
  const applyScannedConnection = await getApplyScannedConnection();
  const classifyScannedConnection = await getClassifyScannedConnection();

  const scanned = {
    relayUrl: "wss://relay.test",
    sttUrl: "",
    ttsUrl: "",
    pushGatewayUrl: "",
  };

  let confirmCallCount = 0;
  let prepareCallCount = 0;
  let writeCallCount = 0;

  const deps = {
    classify: classifyScannedConnection,
    confirm: async () => {
      confirmCallCount++;
      return true;
    },
    prepare: async () => {
      prepareCallCount++;
    },
    write: async () => {
      writeCallCount++;
    },
    validate: (services) => services,
  };

  const result = await applyScannedConnection(null, scanned, deps);
  assert.equal(result, "applied");

  assert.equal(writeCallCount, 1);
  assert.equal(confirmCallCount, 0);
  assert.equal(prepareCallCount, 0);
});

test("T7b: applyScannedConnection on same-community writes, no confirm/prepare", async () => {
  const applyScannedConnection = await getApplyScannedConnection();
  const classifyScannedConnection = await getClassifyScannedConnection();

  const current = {
    relayUrl: "wss://relay.test:6351",
    sttUrl: "",
    ttsUrl: "",
    pushGatewayUrl: "",
  };

  const scanned = {
    relayUrl: "wss://relay.test:6351",
    sttUrl: "wss://stt-new.test/stt",
    ttsUrl: "",
    pushGatewayUrl: "",
  };

  let confirmCallCount = 0;
  let prepareCallCount = 0;
  let writeCallCount = 0;

  const deps = {
    classify: classifyScannedConnection,
    confirm: async () => {
      confirmCallCount++;
      return true;
    },
    prepare: async () => {
      prepareCallCount++;
    },
    write: async () => {
      writeCallCount++;
    },
    validate: (services) => services,
  };

  const result = await applyScannedConnection(current, scanned, deps);
  assert.equal(result, "applied");

  assert.equal(writeCallCount, 1);
  assert.equal(confirmCallCount, 0);
  assert.equal(prepareCallCount, 0);
});

test("T7c: applyScannedConnection on community-change: confirm → prepare → write", async () => {
  const applyScannedConnection = await getApplyScannedConnection();
  const classifyScannedConnection = await getClassifyScannedConnection();

  const current = {
    relayUrl: "wss://relay-old.test:6351",
    sttUrl: "",
    ttsUrl: "",
    pushGatewayUrl: "",
  };

  const scanned = {
    relayUrl: "wss://relay-new.test:6351",
    sttUrl: "",
    ttsUrl: "",
    pushGatewayUrl: "",
  };

  const callOrder = [];

  const deps = {
    classify: classifyScannedConnection,
    confirm: async () => {
      callOrder.push("confirm");
      return true;
    },
    prepare: async () => {
      callOrder.push("prepare");
    },
    write: async () => {
      callOrder.push("write");
    },
    validate: (services) => services,
  };

  const result = await applyScannedConnection(current, scanned, deps);
  assert.equal(result, "applied");

  // Correct order: confirm, then prepare, then write
  assert.deepEqual(callOrder, ["confirm", "prepare", "write"]);
});

test("T7d: applyScannedConnection: user cancellation writes nothing", async () => {
  const applyScannedConnection = await getApplyScannedConnection();
  const classifyScannedConnection = await getClassifyScannedConnection();

  const current = {
    relayUrl: "wss://relay-old.test:6351",
    sttUrl: "",
    ttsUrl: "",
    pushGatewayUrl: "",
  };

  const scanned = {
    relayUrl: "wss://relay-new.test:6351",
    sttUrl: "",
    ttsUrl: "",
    pushGatewayUrl: "",
  };

  let prepareCallCount = 0;
  let writeCallCount = 0;

  const deps = {
    classify: classifyScannedConnection,
    confirm: async () => {
      // User cancels
      return false;
    },
    prepare: async () => {
      prepareCallCount++;
    },
    write: async () => {
      writeCallCount++;
    },
    validate: (services) => services,
  };

  // Should return "cancelled" without throwing
  const result = await applyScannedConnection(current, scanned, deps);
  assert.equal(result, "cancelled");

  // Nothing should be persisted
  assert.equal(writeCallCount, 0);
  assert.equal(prepareCallCount, 0);
});

test("T7e: applyScannedConnection: prepare failure does not write", async () => {
  const applyScannedConnection = await getApplyScannedConnection();
  const classifyScannedConnection = await getClassifyScannedConnection();

  const current = {
    relayUrl: "wss://relay-old.test:6351",
    sttUrl: "",
    ttsUrl: "",
    pushGatewayUrl: "",
  };

  const scanned = {
    relayUrl: "wss://relay-new.test:6351",
    sttUrl: "",
    ttsUrl: "",
    pushGatewayUrl: "",
  };

  let writeCallCount = 0;

  const deps = {
    classify: classifyScannedConnection,
    confirm: async () => true,
    prepare: async () => {
      throw new Error("Prepare failed");
    },
    write: async () => {
      writeCallCount++;
    },
    validate: (services) => services,
  };

  try {
    await applyScannedConnection(current, scanned, deps);
    assert.fail("Should have thrown");
  } catch (e) {
    assert.match(e.message, /Prepare failed/);
    assert.equal(writeCallCount, 0);
  }
});
