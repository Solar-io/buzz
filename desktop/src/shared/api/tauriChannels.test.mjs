import assert from "node:assert/strict";
import test from "node:test";

import { fromRawChannelDetail } from "./tauriChannels.ts";

// `get_channel_details` returns no participant lists (ChannelDetailInfo in
// src-tauri/src/models.rs). A DM resolved that way crashed every DM helper
// with "undefined is not an object (evaluating 'e.participantPubkeys.map')".
test("a channel built from detail has empty participant lists, not undefined", () => {
  const channel = fromRawChannelDetail({
    id: "c1",
    name: "dm",
    channel_type: "dm",
    visibility: "private",
    description: "",
    topic: null,
    purpose: null,
    member_count: 2,
    last_message_at: null,
    archived_at: null,
    ttl_seconds: null,
    ttl_deadline: null,
    created_by: "a",
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    topic_set_by: null,
    topic_set_at: null,
    purpose_set_by: null,
    purpose_set_at: null,
    topic_required: false,
    max_members: null,
    nip29_group_id: null,
  });
  assert.deepEqual(channel.participantPubkeys, []);
  assert.deepEqual(channel.participants, []);
  assert.deepEqual(channel.memberPubkeys, []);
});
