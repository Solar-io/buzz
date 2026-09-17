import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ANSWER_HISTORY_LIMIT,
  CARD_IDS_PER_FILTER,
  answerHistoryRequests,
  answerLiveRequests,
  allRequestsChannelScoped,
  targetedAnswerRequest,
} from "./askQueries.ts";
import {
  MAX_CHANNELS_PER_REQUEST,
  MAX_FILTERS_PER_REQUEST,
  isChannelScopedRequest,
} from "./inboxQuery.ts";

const ids = (n) => Array.from({ length: n }, (_, i) => `card-${i}`);

test("history REQs are global on purpose — #e does the work, #h would shrink them", () => {
  const requests = answerHistoryRequests(["a", "b"]);
  assert.equal(requests.length, 1);
  const [filter] = requests[0];
  assert.deepEqual(filter.kinds, [9]);
  assert.deepEqual(filter["#e"], ["a", "b"]);
  assert.equal(filter["#h"], undefined);
  assert.equal(filter.limit, ANSWER_HISTORY_LIMIT);
  assert.equal(allRequestsChannelScoped(requests), false);
});

test("history card ids batch per filter and filters group per REQ", () => {
  // 530 ids → 11 filters of ≤50 → 2 REQs of ≤10 filters. Both ceilings are
  // relay-enforced (max_filters) or self-imposed to keep REQs small.
  const many = ids(CARD_IDS_PER_FILTER * 10 + 30);
  const requests = answerHistoryRequests(many);
  assert.equal(requests.length, 2);
  let filters = 0;
  for (const request of requests) {
    assert.ok(request.length <= MAX_FILTERS_PER_REQUEST);
    for (const filter of request) {
      filters += 1;
      assert.ok(filter["#e"].length <= CARD_IDS_PER_FILTER);
      assert.equal(filter["#h"], undefined);
    }
  }
  assert.equal(filters, 11);
  // No card lost, none duplicated by the batching.
  const seen = requests.flatMap((request) =>
    request.flatMap((filter) => filter["#e"]),
  );
  assert.equal(new Set(seen).size, many.length);
});

test("askQueries.live filters are channel-scoped", () => {
  // The liveness invariant: EVERY filter carries #h. A #h-less filter in a
  // live REQ would register the whole subscription as Global and the relay
  // would never fan a channel event to it (inboxQuery rule 1/2).
  const requests = answerLiveRequests(["a", "b", "c"], ["ch1", "ch2"], 1_700);
  assert.equal(requests.length, 1);
  assert.equal(allRequestsChannelScoped(requests), true);
  const [filter] = requests[0];
  assert.deepEqual(filter.kinds, [9]);
  assert.deepEqual(filter["#h"], ["ch1", "ch2"]);
  assert.deepEqual(filter["#e"], ["a", "b", "c"]);
  assert.equal(filter.since, 1_700);
  assert.equal(filter.limit, undefined);
});

test("live requests chunk channels at 128 and re-issue the #e list per chunk", () => {
  const channels = Array.from(
    { length: MAX_CHANNELS_PER_REQUEST + 3 },
    (_, i) => `ch-${i}`,
  );
  const requests = answerLiveRequests(["a"], channels, 5);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0][0]["#h"].length, MAX_CHANNELS_PER_REQUEST);
  assert.equal(requests[1][0]["#h"].length, 3);
  for (const request of requests) {
    assert.equal(isChannelScopedRequest(request), true);
    assert.deepEqual(request[0]["#e"], ["a"]);
    assert.equal(request[0].since, 5);
  }
});

test("no tracked cards means no live REQs at all", () => {
  assert.deepEqual(answerLiveRequests([], ["ch1"], 1), []);
  // Empty ids are dropped and duplicates collapse — the #e list sent to the
  // relay is exactly the tracked set.
  const requests = answerLiveRequests(["", "a", "a"], ["ch1"], 1);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0][0]["#e"], ["a"]);
});

test("the targeted tap query is one cheap global REQ for exactly one card", () => {
  const request = targetedAnswerRequest("card-9");
  assert.equal(request.length, 1);
  const filter = request[0];
  assert.deepEqual(filter["#e"], ["card-9"]);
  assert.equal(filter.limit, 100);
  assert.equal(filter["#h"], undefined);
});
