import type { Page } from "@playwright/test";

/**
 * A relay, faked at the WebSocket boundary.
 *
 * The other specs in this directory run with no relay at all, which proves a
 * pane mounts but nothing about what it does with data. Several of the things
 * worth proving here only exist once data arrives — a virtualized list that
 * renders a WINDOW of its rows rather than all of them, a moderation queue
 * that offers different resolutions to a community owner depending on whether
 * they also hold a role in the reported channel. Those cannot be tested by
 * mounting an empty state, and they are exactly the shape of bug that ships
 * green: correct code that nothing ever reaches.
 *
 * So this replies to the client's real REQs with real Nostr frames. It is not
 * a relay: it does not verify signatures, enforce scope, or apply the p-gate,
 * and it must never be used to make a claim about relay behaviour. It exists
 * so the CLIENT can be driven.
 *
 * `page.routeWebSocket` handles the socket entirely in the page when the route
 * never calls `connectToServer`, so no listener is opened and no port is
 * claimed. The client's session sends no AUTH of its own until challenged, and
 * treats the socket as usable once its 1s auth grace expires with no
 * challenge — so a mock that simply never challenges is the fastest correct
 * behaviour, and matches a relay running without `require_auth_token`.
 */

export interface MockEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/** A Nostr filter, as the client sends it. */
type Filter = {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
} & Record<string, unknown>;

/** Build an event with plausible defaults. The signature is not checked. */
export function mockEvent(overrides: Partial<MockEvent> = {}): MockEvent {
  return {
    id: overrides.id ?? "00".repeat(32),
    pubkey: overrides.pubkey ?? "11".repeat(32),
    created_at: overrides.created_at ?? Math.floor(Date.now() / 1000),
    kind: overrides.kind ?? 1,
    tags: overrides.tags ?? [],
    content: overrides.content ?? "",
    sig: overrides.sig ?? "ab".repeat(64),
  };
}

/** A hex id derived from a counter, so fixtures read as distinct ids. */
export function hexId(seed: number, fill = "0"): string {
  return String(seed).padStart(64, fill);
}

/** Does one event satisfy one filter? Enough of NIP-01 to drive the client. */
function matches(filter: Filter, event: MockEvent): boolean {
  if (filter.ids && !filter.ids.includes(event.id)) {
    return false;
  }
  if (filter.kinds && !filter.kinds.includes(event.kind)) {
    return false;
  }
  if (filter.authors && !filter.authors.includes(event.pubkey)) {
    return false;
  }
  if (typeof filter.since === "number" && event.created_at < filter.since) {
    return false;
  }
  if (typeof filter.until === "number" && event.created_at > filter.until) {
    return false;
  }
  for (const [key, value] of Object.entries(filter)) {
    if (!key.startsWith("#") || !Array.isArray(value)) {
      continue;
    }
    const name = key.slice(1);
    const present = event.tags
      .filter((tag) => tag[0] === name)
      .map((tag) => tag[1]);
    if (!present.some((tagValue) => (value as string[]).includes(tagValue))) {
      return false;
    }
  }
  return true;
}

export interface MockRelay {
  /** Every EVENT frame the client published, in order. */
  published: MockEvent[];
  /** Add events after the page has loaded; they are served to later REQs. */
  add: (...events: MockEvent[]) => void;
}

/**
 * Serve `events` to every REQ the page opens, and acknowledge every publish.
 *
 * Install BEFORE navigating. Returns a handle whose `published` array records
 * what the client sent — which is how a spec asserts that clicking "Delete
 * post" actually produced a delete event rather than only closing a dialog.
 */
export async function installMockRelay(
  page: Page,
  events: MockEvent[] = [],
): Promise<MockRelay> {
  const served = [...events];
  const published: MockEvent[] = [];

  await page.routeWebSocket(/.*/, (ws) => {
    ws.onMessage((raw) => {
      if (typeof raw !== "string") {
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(raw);
      } catch {
        return;
      }
      if (!Array.isArray(message) || message.length === 0) {
        return;
      }
      const [type] = message as [string];
      if (type === "REQ") {
        const subId = String(message[1]);
        const filters = message.slice(2) as Filter[];
        for (const event of served) {
          if (filters.some((filter) => matches(filter, event))) {
            ws.send(JSON.stringify(["EVENT", subId, event]));
          }
        }
        ws.send(JSON.stringify(["EOSE", subId]));
        return;
      }
      if (type === "EVENT") {
        // The route handler runs in Node, so the record is just an array push
        // — no page bridge needed — and a spec can read it synchronously.
        const event = message[1] as MockEvent;
        published.push(event);
        ws.send(JSON.stringify(["OK", event.id, true, ""]));
        return;
      }
      // CLOSE and AUTH need no reply from a relay that never challenges.
    });
  });

  return {
    published,
    add: (...more: MockEvent[]) => {
      served.push(...more);
    },
  };
}
