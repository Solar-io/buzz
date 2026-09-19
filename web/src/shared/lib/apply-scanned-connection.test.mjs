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

// T7: applyScannedConnection with fakes: prepare once and strictly before write on
// community-change; zero on same-community; write never on validation throw

test("T7a: applyScannedConnection on first-run writes, no prepare", async () => {
  const applyScannedConnection = await getApplyScannedConnection();
  const classifyScannedConnection = await getClassifyScannedConnection();

  const scanned = {
    relayUrl: "wss://relay.test",
    sttUrl: "",
    ttsUrl: "",
    pushGatewayUrl: "",
  };

  let prepareCallCount = 0;
  let writeCallCount = 0;

  const deps = {
    classify: classifyScannedConnection,
    prepare: async () => {
      prepareCallCount++;
    },
    write: async () => {
      writeCallCount++;
    },
  };

  await applyScannedConnection(null, scanned, deps);

  assert.equal(writeCallCount, 1);
  assert.equal(prepareCallCount, 0);
});

test("T7b: applyScannedConnection on same-community writes, no prepare", async () => {
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

  let prepareCallCount = 0;
  let writeCallCount = 0;

  const deps = {
    classify: classifyScannedConnection,
    prepare: async () => {
      prepareCallCount++;
    },
    write: async () => {
      writeCallCount++;
    },
  };

  await applyScannedConnection(current, scanned, deps);

  assert.equal(writeCallCount, 1);
  assert.equal(prepareCallCount, 0);
});

test("T7c: applyScannedConnection on community-change calls prepare after write", async () => {
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
    prepare: async () => {
      callOrder.push("prepare");
    },
    write: async () => {
      callOrder.push("write");
    },
  };

  await applyScannedConnection(current, scanned, deps);

  // Write must come before prepare
  assert.deepEqual(callOrder, ["write", "prepare"]);
});

test("T7d: applyScannedConnection - write is never called if validation throws", async () => {
  const applyScannedConnection = await getApplyScannedConnection();

  const scanned = {
    relayUrl: "wss://relay.test",
    sttUrl: "",
    ttsUrl: "",
    pushGatewayUrl: "",
  };

  let writeCallCount = 0;

  // Classifier throws (simulating validation failure)
  const deps = {
    classify: () => {
      throw new Error("Validation failed");
    },
    prepare: async () => {},
    write: async () => {
      writeCallCount++;
    },
  };

  try {
    await applyScannedConnection(null, scanned, deps);
    assert.fail("Should have thrown");
  } catch (e) {
    assert.match(e.message, /Validation failed/);
    assert.equal(writeCallCount, 0);
  }
});
