import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DM_HISTORY_LIMIT,
  INBOX_MENTION_KINDS,
  MAX_CHANNELS_PER_REQUEST,
  MENTION_HISTORY_LIMIT,
  chunkChannelIds,
  dmRequests,
  inboxRequests,
  isChannelScopedRequest,
  mentionHistoryRequest,
  mentionLiveRequests,
} from "./inboxQuery.ts";

const SELF = "aa".repeat(32);
const channelIds = ["c1", "c2", "c3"];
const dmIds = ["d1", "d2"];

test("the mention history request is global — no #h, so history only", () => {
  const [filter] = mentionHistoryRequest(SELF);
  assert.deepEqual(filter.kinds, [...INBOX_MENTION_KINDS]);
  assert.deepEqual(filter["#p"], [SELF]);
  assert.equal(filter["#h"], undefined);
  assert.equal(filter.limit, MENTION_HISTORY_LIMIT);
  assert.equal(filter.since, undefined);
});

test("the live mention request carries #h AND #p, and a since cutoff", () => {
  const requests = mentionLiveRequests(channelIds, SELF, 1_700);
  assert.equal(requests.length, 1);
  const [filter] = requests[0];
  assert.deepEqual(filter["#h"], channelIds);
  assert.deepEqual(filter["#p"], [SELF]);
  assert.equal(filter.since, 1_700);
  assert.equal(filter.limit, undefined);
});

test("the DM request is channel-scoped, so it is live without a second REQ", () => {
  const requests = dmRequests(dmIds);
  assert.equal(requests.length, 1);
  const [filter] = requests[0];
  assert.deepEqual(filter.kinds, [9]);
  assert.deepEqual(filter["#h"], dmIds);
  assert.equal(filter["#p"], undefined);
  assert.equal(filter.limit, DM_HISTORY_LIMIT);
  assert.equal(isChannelScopedRequest(requests[0]), true);
});

test("no requests at all without a viewer key", () => {
  assert.deepEqual(
    inboxRequests({
      selfPubkey: null,
      channelIds,
      dmChannelIds: dmIds,
      since: 1,
    }),
    [],
  );
});

test("the #h-less filter NEVER shares a request with an #h filter", () => {
  // The relay resolves ONE scope per REQ: extract_channel_ids_from_filters
  // returns None as soon as any filter lacks #h, which registers the whole
  // subscription as Global — and a Global subscription receives no live
  // channel events. Bundling to save a round trip silently kills liveness.
  const requests = inboxRequests({
    selfPubkey: SELF,
    channelIds,
    dmChannelIds: dmIds,
    since: 1_700,
  });
  assert.equal(requests.length, 3);
  for (const request of requests) {
    const withH = request.filter((filter) => filter["#h"] !== undefined);
    assert.ok(
      withH.length === 0 || withH.length === request.length,
      "a request must be entirely #h-scoped or entirely global",
    );
  }
  // Exactly one global request (the mention history), the rest channel-scoped.
  assert.equal(requests.filter((r) => !isChannelScopedRequest(r)).length, 1);
  assert.equal(requests.filter(isChannelScopedRequest).length, 2);
});

test("channel ids are chunked under the relay's per-REQ cap", () => {
  const many = Array.from(
    { length: MAX_CHANNELS_PER_REQUEST * 2 + 7 },
    (_, index) => `ch-${index}`,
  );
  const chunks = chunkChannelIds(many);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].length, MAX_CHANNELS_PER_REQUEST);
  assert.equal(chunks[1].length, MAX_CHANNELS_PER_REQUEST);
  assert.equal(chunks[2].length, 7);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= MAX_CHANNELS_PER_REQUEST);
  }

  const requests = mentionLiveRequests(many, SELF, 1);
  assert.equal(requests.length, 3);
  for (const request of requests) {
    for (const filter of request) {
      assert.ok(filter["#h"].length <= MAX_CHANNELS_PER_REQUEST);
    }
  }
});

test("chunking dedupes and drops empty ids", () => {
  assert.deepEqual(chunkChannelIds(["a", "a", "", "b"]), [["a", "b"]]);
  assert.deepEqual(chunkChannelIds([]), []);
  assert.deepEqual(dmRequests([]), []);
});

test("an empty channel list yields only the global mention request", () => {
  const requests = inboxRequests({
    selfPubkey: SELF,
    channelIds: [],
    dmChannelIds: [],
    since: 1_700,
  });
  assert.equal(requests.length, 1);
  assert.equal(isChannelScopedRequest(requests[0]), false);
});
