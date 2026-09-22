import assert from "node:assert/strict";
import { after, test } from "node:test";

/**
 * Lifecycle tests for the boot-to-live read-state subscription — the relay
 * interaction half of NIP-RS, which readStateSyncBlob.test.mjs deliberately
 * does not cover (that file is the pure wire format).
 *
 * The signer is stubbed at the module seam (cardDraft.test.mjs's pattern):
 * decrypt/encrypt/sign become a controllable map, so these tests observe
 * WHAT WAS DECRYPTED, PUBLISHED, and NOTIFIED without any crypto. The relay
 * session is a structural fake with the two methods readStateSync uses
 * (subscribe/publish) plus emit/eose to play the relay. window and
 * localStorage are per-test fakes on globalThis — the real stores are
 * imported and read back through them.
 *
 * Timer discipline: the publish debounce (5s) is always flushed through the
 * shipped pagehide escape hatch instead of being waited out; the live
 * coalesce window (100ms) is waited for real. Every test disposes the sync
 * in t.after so no timer outlives its state.
 */

globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  "@/shared/lib/nostr-signer": `
    const ctl = globalThis.__RS_TEST_SIGNER__;
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    export async function nip44DecryptFrom(ciphertext, _peer) {
      if (ctl.decryptDelayMs > 0) await sleep(ctl.decryptDelayMs);
      return { plaintext: ctl.decrypt(ciphertext) };
    }
    export async function nip44EncryptTo(plaintext, _peer) {
      return { ciphertext: ctl.encrypt(plaintext) };
    }
    export async function signNostrEvent(template) {
      return ctl.sign(template);
    }
  `,
};

function makeSignerCtl() {
  return {
    /** ciphertext → plaintext (the "key"); unknown ciphertext throws. */
    ciphertexts: new Map(),
    decryptCalls: [],
    /** encrypt() inputs in order — the published blobs, readable. */
    plaintexts: [],
    signCount: 0,
    decryptDelayMs: 0,
    signingPubkey: "",
    seq: 0,
    reset() {
      this.ciphertexts.clear();
      this.decryptCalls.length = 0;
      this.plaintexts.length = 0;
      this.signCount = 0;
      this.decryptDelayMs = 0;
      this.seq = 0;
    },
    decrypt(ciphertext) {
      this.decryptCalls.push(ciphertext);
      const plaintext = this.ciphertexts.get(ciphertext);
      if (plaintext === undefined) {
        throw new Error("undecryptable");
      }
      return plaintext;
    },
    encrypt(plaintext) {
      this.plaintexts.push(plaintext);
      const ciphertext = `ct-${++this.seq}`;
      this.ciphertexts.set(ciphertext, plaintext);
      return ciphertext;
    },
    sign(template) {
      this.signCount += 1;
      return {
        ...template,
        id: `own-ev-${++this.seq}`,
        pubkey: this.signingPubkey,
        sig: "sig",
      };
    },
    /** Seal a blob into a ciphertext this stub can decrypt again. */
    seal(value) {
      const ciphertext = `ct-${++this.seq}`;
      this.ciphertexts.set(ciphertext, JSON.stringify(value));
      return ciphertext;
    },
  };
}

globalThis.__RS_TEST_SIGNER__ = makeSignerCtl();

const {
  READ_STATE_SYNCED_EVENT,
  initReadStateSync,
  disposeReadStateSync,
  notifyReadStateLocalChange,
} = await import("./readStateSync.ts");
const { loadReadState, saveReadState } = await import("./readState.ts");
const { loadInboxReadState } = await import("../../home/lib/inboxReadState.ts");

const signerCtl = globalThis.__RS_TEST_SIGNER__;
let eventSeq = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, label, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(10);
  }
  assert.ok(predicate(), `timeout waiting for: ${label}`);
}

function fakeLocalStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

function fakeWindow() {
  const listeners = new Map();
  return {
    dispatched: [],
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatchEvent(event) {
      this.dispatched.push(event.type);
      for (const fn of listeners.get(event.type) ?? []) {
        fn(event);
      }
      return true;
    },
    listenerCount(type) {
      return listeners.get(type)?.size ?? 0;
    },
    syncedEventCount() {
      return this.dispatched.filter((type) => type === READ_STATE_SYNCED_EVENT)
        .length;
    },
  };
}

function fakeSession() {
  const subs = [];
  const published = [];
  return {
    subs,
    published,
    subscribe(filter, options) {
      const sub = { filter, options, closed: false, closedCount: 0 };
      subs.push(sub);
      return () => {
        sub.closed = true;
        sub.closedCount += 1;
      };
    },
    publish(event) {
      published.push(event);
      return Promise.resolve({ ok: true, message: "" });
    },
    emit(event) {
      for (const sub of subs) {
        if (!sub.closed) sub.options.onEvent(event);
      }
    },
    eose() {
      for (const sub of subs) {
        if (!sub.closed) sub.options.onEose?.();
      }
    },
    openSubs() {
      return subs.filter((sub) => !sub.closed);
    },
  };
}

/** A foreign device's kind:30078 read-state event (own pubkey, other slot). */
function foreignEvent(pubkey, { id, slotId, createdAt, content }) {
  return {
    id: id ?? `ev-${++eventSeq}`,
    pubkey,
    sig: "sig",
    kind: 30078,
    created_at: createdAt,
    tags: [
      ["d", `read-state:${slotId ?? "f".repeat(32)}`],
      ["t", "read-state"],
    ],
    content,
  };
}

function freshHarness(signingPubkey) {
  signerCtl.reset();
  signerCtl.signingPubkey = signingPubkey;
  const ls = fakeLocalStorage();
  const win = fakeWindow();
  globalThis.localStorage = ls;
  globalThis.window = win;
  return { ls, win };
}

function ownSlotId(ls, pubkey) {
  return ls.getItem(`buzz.nip-rs.slot-id:${pubkey}`);
}

after(() => {
  disposeReadStateSync();
  delete globalThis.__BUZZ_TEST_MODULE_STUBS__;
  delete globalThis.__RS_TEST_SIGNER__;
  delete globalThis.window;
  delete globalThis.localStorage;
});

// --- boot phase -----------------------------------------------------------

test("boot: batch-merges every slot until EOSE, fires the synced event once, never publishes, and stays open past EOSE", async (t) => {
  const pubkey = "a".repeat(64);
  const { win } = freshHarness(pubkey);
  t.after(() => disposeReadStateSync());
  const session = fakeSession();

  initReadStateSync({ session, selfPubkey: pubkey });
  assert.deepEqual(session.subs[0].filter, {
    kinds: [30078],
    authors: [pubkey],
    "#t": ["read-state"],
    limit: 64,
  });

  session.emit(
    foreignEvent(pubkey, {
      createdAt: 500,
      content: signerCtl.seal({
        v: 1,
        client_id: "dev1",
        contexts: { chA: 100 },
      }),
    }),
  );
  session.emit(
    foreignEvent(pubkey, {
      createdAt: 600,
      slotId: "e".repeat(32),
      content: signerCtl.seal({
        v: 1,
        client_id: "dev2",
        contexts: { chB: 200 },
        inbox_read: { m1: 10 },
      }),
    }),
  );
  session.eose();

  await waitFor(() => win.syncedEventCount() === 1, "boot synced event");
  assert.deepEqual(loadReadState(), { chA: 100, chB: 200 });
  assert.deepEqual(loadInboxReadState().read, { m1: 10 });
  assert.equal(session.published.length, 0, "boot alone never publishes");
  assert.equal(
    session.openSubs().length,
    1,
    "subscription stays open after EOSE",
  );
});

test("boot: a decrypt accepted before EOSE but resolving after still lands in the batch", async (t) => {
  const pubkey = "b".repeat(64);
  const { win } = freshHarness(pubkey);
  t.after(() => disposeReadStateSync());
  const session = fakeSession();
  signerCtl.decryptDelayMs = 80;

  initReadStateSync({ session, selfPubkey: pubkey });
  session.emit(
    foreignEvent(pubkey, {
      createdAt: 900,
      content: signerCtl.seal({
        v: 1,
        client_id: "dev1",
        contexts: { chLate: 5 },
      }),
    }),
  );
  session.eose();

  await waitFor(
    () => Object.keys(loadReadState()).length === 1,
    "late decrypt landed",
  );
  assert.deepEqual(loadReadState(), { chLate: 5 });
  assert.equal(win.syncedEventCount(), 1);
});

test("boot: an undecryptable event is skipped without killing the batch, and its created_at still pins the next publish", async (t) => {
  const pubkey = "c".repeat(64);
  const { win } = freshHarness(pubkey);
  t.after(() => disposeReadStateSync());
  const session = fakeSession();
  // A foreign clock running ahead: the pin must beat even undecryptable events.
  const future = Math.floor(Date.now() / 1000) + 5_000;

  initReadStateSync({ session, selfPubkey: pubkey });
  session.emit(
    foreignEvent(pubkey, {
      id: "undecryptable",
      createdAt: future,
      content: "not-a-known-ciphertext",
    }),
  );
  session.emit(
    foreignEvent(pubkey, {
      createdAt: future - 1,
      content: signerCtl.seal({
        v: 1,
        client_id: "dev1",
        contexts: { chGood: 7 },
      }),
    }),
  );
  session.eose();

  await waitFor(() => loadReadState().chGood === 7, "good blob merged");
  notifyReadStateLocalChange();
  win.dispatchEvent({ type: "pagehide" });
  await waitFor(
    () => session.published.length === 1,
    "debounced publish flushed",
  );
  assert.ok(
    session.published[0].created_at >= future + 1,
    "publish beats the undecryptable event's created_at (the pin)",
  );
});

// --- live phase -----------------------------------------------------------

test("live: foreign read marker arriving AFTER EOSE advances the store and notifies once per coalesced burst (post-EOSE live handling)", async (t) => {
  const pubkey = "d".repeat(64);
  const { win } = freshHarness(pubkey);
  t.after(() => disposeReadStateSync());
  const session = fakeSession();

  initReadStateSync({ session, selfPubkey: pubkey });
  session.eose();
  win.dispatched.length = 0;

  session.emit(
    foreignEvent(pubkey, {
      createdAt: 2_000,
      content: signerCtl.seal({
        v: 1,
        client_id: "dev1",
        contexts: { chLive: 300 },
      }),
    }),
  );
  session.emit(
    foreignEvent(pubkey, {
      createdAt: 2_100,
      slotId: "e".repeat(32),
      content: signerCtl.seal({
        v: 1,
        client_id: "dev2",
        contexts: { chLive2: 310 },
        inbox_unread: { m2: 1 },
      }),
    }),
  );

  await waitFor(
    () => loadReadState().chLive === 300 && loadReadState().chLive2 === 310,
    "live markers merged",
  );
  assert.deepEqual(loadInboxReadState().unread, { m2: 1 });
  assert.equal(
    win.syncedEventCount(),
    1,
    "the two-event burst coalesced into one notification",
  );
});

test("live: a foreign burst with nothing newer than local notifies nothing and publishes nothing", async (t) => {
  const pubkey = "1".repeat(64);
  const { win } = freshHarness(pubkey);
  t.after(() => disposeReadStateSync());
  saveReadState({ chStale: 500 });
  const session = fakeSession();

  initReadStateSync({ session, selfPubkey: pubkey });
  session.eose();
  win.dispatched.length = 0;

  session.emit(
    foreignEvent(pubkey, {
      createdAt: 2_500,
      content: signerCtl.seal({
        v: 1,
        client_id: "dev1",
        contexts: { chStale: 100 },
      }),
    }),
  );
  await sleep(250);

  assert.equal(win.syncedEventCount(), 0, "stale markers do not notify");
  assert.equal(
    loadReadState().chStale,
    500,
    "grow-only: local marker untouched",
  );
  win.dispatchEvent({ type: "pagehide" });
  await sleep(50);
  assert.equal(
    session.published.length,
    0,
    "no advance means no convergence republish",
  );
});

// --- dedupe / own echo ------------------------------------------------------

test("dedupe: a replayed event id (reconnect replay) is dropped before decrypt and never re-notifies", async (t) => {
  const pubkey = "e".repeat(64);
  const { win } = freshHarness(pubkey);
  t.after(() => disposeReadStateSync());
  const session = fakeSession();
  const replayed = foreignEvent(pubkey, {
    id: "dup-1",
    createdAt: 1_500,
    content: signerCtl.seal({ v: 1, client_id: "dev1", contexts: { chD: 42 } }),
  });

  initReadStateSync({ session, selfPubkey: pubkey });
  session.emit(replayed);
  session.eose();
  await waitFor(() => loadReadState().chD === 42, "first delivery merged");

  const decryptCallsBefore = signerCtl.decryptCalls.length;
  win.dispatched.length = 0;
  session.emit(replayed);
  session.eose();
  await sleep(250);

  assert.equal(
    signerCtl.decryptCalls.length,
    decryptCallsBefore,
    "no second decrypt",
  );
  assert.equal(win.syncedEventCount(), 0, "no second notification");
  assert.equal(session.published.length, 0);
});

test("own echo: the published event fed back on the open subscription is dropped before decrypt and never re-publishes", async (t) => {
  const pubkey = "f".repeat(64);
  const { win, ls } = freshHarness(pubkey);
  t.after(() => disposeReadStateSync());
  const session = fakeSession();

  initReadStateSync({ session, selfPubkey: pubkey });
  session.eose();
  saveReadState({ chLocal: 5 });
  notifyReadStateLocalChange();
  win.dispatchEvent({ type: "pagehide" });
  await waitFor(() => session.published.length === 1, "own publish flushed");

  const own = session.published[0];
  assert.equal(own.tags[0][1], `read-state:${ownSlotId(ls, pubkey)}`);
  session.emit(own);
  session.eose();
  await sleep(250);

  assert.equal(
    signerCtl.decryptCalls.length,
    0,
    "own echo dropped before decrypt",
  );
  assert.equal(win.syncedEventCount(), 0, "own echo notifies nothing");
  win.dispatchEvent({ type: "pagehide" });
  await sleep(50);
  assert.equal(
    session.published.length,
    1,
    "no self-republish (no ping-pong with ourselves)",
  );
});

test("recovery: a prior-session own-slot event with an unseen id is decrypted and merged at boot (NIP-RS Fetching step 4)", async (t) => {
  const pubkey = "9".repeat(64);
  const { win, ls } = freshHarness(pubkey);
  const firstSession = fakeSession();
  initReadStateSync({ session: firstSession, selfPubkey: pubkey });
  firstSession.eose();
  const slotId = ownSlotId(ls, pubkey);
  // "Reload": the in-memory event-id set is gone and the local read-state
  // store is lost, but the persisted slot id (and the relay's own-slot blob)
  // survives. A fresh state must merge its own prior blob back.
  disposeReadStateSync();
  t.after(() => disposeReadStateSync());

  const session = fakeSession();
  initReadStateSync({ session, selfPubkey: pubkey });
  session.emit(
    foreignEvent(pubkey, {
      id: "prior-session-publish",
      slotId,
      createdAt: 4_000,
      content: signerCtl.seal({
        v: 1,
        client_id: "prior-session",
        contexts: { chRecovered: 77 },
      }),
    }),
  );
  session.eose();

  await waitFor(
    () => loadReadState().chRecovered === 77,
    "own-slot recovery blob merged at boot",
  );
  assert.equal(win.syncedEventCount(), 1);
  // The boot restore arms no publish (boot advances never do), so recovery
  // via boot costs zero publishes — stronger than "one is acceptable".
  win.dispatchEvent({ type: "pagehide" });
  await sleep(50);
  assert.equal(session.published.length, 0, "boot recovery publishes nothing");
});

test("recovery (live): an unseen own-slot marker after EOSE merges once, pays one convergence republish, and the echo does not loop", async (t) => {
  const pubkey = "0".repeat(64);
  const { win, ls } = freshHarness(pubkey);
  const firstSession = fakeSession();
  initReadStateSync({ session: firstSession, selfPubkey: pubkey });
  firstSession.eose();
  const slotId = ownSlotId(ls, pubkey);
  disposeReadStateSync();
  t.after(() => disposeReadStateSync());

  const session = fakeSession();
  initReadStateSync({ session, selfPubkey: pubkey });
  session.eose();
  win.dispatched.length = 0;

  session.emit(
    foreignEvent(pubkey, {
      id: "prior-session-live",
      slotId,
      createdAt: 4_500,
      content: signerCtl.seal({
        v: 1,
        client_id: "prior-session",
        contexts: { chLiveRecovery: 88 },
      }),
    }),
  );
  await waitFor(
    () => loadReadState().chLiveRecovery === 88,
    "own-slot recovery marker merged despite the own coordinate",
  );

  // A recovery advance may pay ONE convergence republish (acceptable).
  win.dispatchEvent({ type: "pagehide" });
  await waitFor(() => session.published.length === 1, "one recovery republish");
  assert.equal(
    JSON.parse(signerCtl.plaintexts[signerCtl.plaintexts.length - 1]).contexts
      .chLiveRecovery,
    88,
    "republished slot carries the recovered marker",
  );

  // The relay echoes the republish back. Its id was remembered before the
  // EVENT left, so the echo is dropped before decrypt and re-arms nothing.
  const decryptCallsBefore = signerCtl.decryptCalls.length;
  session.emit(session.published[0]);
  session.eose();
  await sleep(250);
  assert.equal(
    signerCtl.decryptCalls.length,
    decryptCallsBefore,
    "echo of the recovery republish not decrypted",
  );
  win.dispatchEvent({ type: "pagehide" });
  await sleep(50);
  assert.equal(session.published.length, 1, "the recovery does not loop");
});

// --- convergence republish -------------------------------------------------

test("convergence: a foreign advance republishes the union, and the echo of that republish does not loop", async (t) => {
  const pubkey = "2".repeat(64);
  const { win } = freshHarness(pubkey);
  t.after(() => disposeReadStateSync());
  const session = fakeSession();

  initReadStateSync({ session, selfPubkey: pubkey });
  session.eose();

  session.emit(
    foreignEvent(pubkey, {
      createdAt: 3_000,
      content: signerCtl.seal({
        v: 1,
        client_id: "dev1",
        contexts: { chA: 200 },
      }),
    }),
  );
  await waitFor(() => loadReadState().chA === 200, "foreign advance merged");
  win.dispatchEvent({ type: "pagehide" });
  await waitFor(
    () => session.published.length === 1,
    "convergence republish flushed",
  );
  assert.equal(
    JSON.parse(signerCtl.plaintexts[0]).contexts.chA,
    200,
    "republished slot carries the foreign marker",
  );

  // The relay echoes our republish back on the still-open subscription.
  session.emit(session.published[0]);
  session.eose();
  await sleep(250);
  assert.equal(
    session.published.length,
    1,
    "echo of the republish triggers nothing (terminates)",
  );

  // A genuinely new foreign marker converges again.
  session.emit(
    foreignEvent(pubkey, {
      createdAt: 3_200,
      slotId: "3".repeat(32),
      content: signerCtl.seal({
        v: 1,
        client_id: "dev2",
        contexts: { chB: 400 },
      }),
    }),
  );
  await waitFor(
    () => loadReadState().chB === 400,
    "second foreign advance merged",
  );
  win.dispatchEvent({ type: "pagehide" });
  await waitFor(
    () => session.published.length === 2,
    "second republish flushed",
  );
  const second = JSON.parse(signerCtl.plaintexts[1]);
  assert.deepEqual(
    { chA: second.contexts.chA, chB: second.contexts.chB },
    { chA: 200, chB: 400 },
    "second republish carries the full union",
  );
});

// --- replacement / teardown --------------------------------------------------

test("identity replacement: closes the old REQ exactly once, and a boot decrypt landing after the switch never writes", async (t) => {
  const pubA = "4".repeat(64);
  const pubB = "5".repeat(64);
  const { win } = freshHarness(pubA);
  t.after(() => disposeReadStateSync());
  signerCtl.signingPubkey = pubA;
  const sessionA = fakeSession();
  const sessionB = fakeSession();
  signerCtl.decryptDelayMs = 150;

  initReadStateSync({ session: sessionA, selfPubkey: pubA });
  sessionA.emit(
    foreignEvent(pubA, {
      createdAt: 100,
      content: signerCtl.seal({
        v: 1,
        client_id: "dev1",
        contexts: { chA1: 11 },
      }),
    }),
  );
  sessionA.eose();
  // Identity switch while A's boot decrypts are still draining.
  initReadStateSync({ session: sessionB, selfPubkey: pubB });

  assert.equal(
    sessionA.subs.length,
    1,
    "old session saw exactly one subscribe",
  );
  assert.equal(sessionA.subs[0].closedCount, 1, "old REQ closed exactly once");
  assert.equal(
    sessionB.openSubs().length,
    1,
    "new identity opened its own REQ",
  );
  assert.equal(
    win.listenerCount("pagehide"),
    1,
    "the dead identity's pagehide listener is gone",
  );

  sessionB.emit(
    foreignEvent(pubB, {
      createdAt: 200,
      content: signerCtl.seal({
        v: 1,
        client_id: "dev1",
        contexts: { chB1: 22 },
      }),
    }),
  );
  sessionB.eose();
  await waitFor(() => loadReadState().chB1 === 22, "B's boot merged");
  await sleep(300);

  assert.equal(
    loadReadState().chA1,
    undefined,
    "dead identity's late decrypt never merged",
  );
  assert.equal(win.syncedEventCount(), 1, "only B's boot notified");
  assert.equal(sessionA.published.length, 0, "dead identity never publishes");
});

test("session replacement under one identity moves the subscription and the dedupe survives the move", async (t) => {
  const pubkey = "6".repeat(64);
  const { win } = freshHarness(pubkey);
  t.after(() => disposeReadStateSync());
  const sessionA = fakeSession();
  const sessionB = fakeSession();

  initReadStateSync({ session: sessionA, selfPubkey: pubkey });
  const replayed = foreignEvent(pubkey, {
    id: "keep-1",
    createdAt: 1_800,
    content: signerCtl.seal({ v: 1, client_id: "dev1", contexts: { chM: 50 } }),
  });
  sessionA.emit(replayed);
  sessionA.eose();
  await waitFor(() => loadReadState().chM === 50, "boot merged on old session");

  initReadStateSync({ session: sessionB, selfPubkey: pubkey });
  assert.equal(sessionA.subs[0].closedCount, 1, "old session's REQ closed");
  assert.equal(
    sessionB.openSubs().length,
    1,
    "new session has the subscription",
  );
  assert.deepEqual(
    sessionB.subs[0].filter,
    sessionA.subs[0].filter,
    "same NIP-RS filter after the move",
  );

  // The new session replays what the old one already delivered (reconnect
  // overlap): dedupe must swallow it without a second decrypt or notify.
  const decryptCallsBefore = signerCtl.decryptCalls.length;
  win.dispatched.length = 0;
  sessionB.emit(replayed);
  sessionB.eose();
  await sleep(250);
  assert.equal(
    signerCtl.decryptCalls.length,
    decryptCallsBefore,
    "replayed overlap not re-decrypted",
  );
  assert.equal(win.syncedEventCount(), 0);

  // A NEW foreign marker on the new session still merges live.
  sessionB.emit(
    foreignEvent(pubkey, {
      createdAt: 5_000,
      slotId: "7".repeat(32),
      content: signerCtl.seal({
        v: 1,
        client_id: "dev2",
        contexts: { chM2: 60 },
      }),
    }),
  );
  await waitFor(
    () => loadReadState().chM2 === 60,
    "live merge works on the moved subscription",
  );
});
