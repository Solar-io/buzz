/**
 * Persistent relay session: one WebSocket with NIP-42 AUTH, automatic
 * reconnect with backoff, and subscription bookkeeping that replays active
 * subscriptions after any reconnect.
 *
 * Framework-free by injection: `webSocketFactory` and `signAuthEvent` are
 * injectable so the protocol state machine is unit-testable under node with
 * a scripted fake socket.
 */

import type {
  SignedNostrEvent,
  UnsignedNostrEvent,
} from "../lib/nostr-signer.ts";
import { signNostrEvent as defaultSignNostrEvent } from "../lib/nostr-signer.ts";
import { getAuthTagJson } from "../lib/key-store.ts";
import type { NostrFilter } from "../lib/nostr-client.ts";

export type RelaySessionStatus =
  | "idle"
  | "connecting"
  | "authenticating"
  | "open"
  | "reconnecting"
  | "closed";

export interface SubscribeOptions {
  onEvent: (event: SignedNostrEvent) => void;
  onEose?: () => void;
}

export type Unsubscribe = () => void;

export interface RelaySessionOptions {
  wsUrl: string;
  webSocketFactory?: (url: string) => MinimalWebSocket;
  /** Signs NIP-42 AUTH events; defaults to the shared signer. */
  signAuthEvent?: (
    challenge: string,
    relayUrl: string,
  ) => Promise<SignedNostrEvent>;
  /** Delay before reconnect attempt N (0-based). Default: capped exponential. */
  reconnectDelayMs?: (attempt: number) => number;
  /** How long to wait for an AUTH challenge before proceeding unauthenticated. */
  authGraceMs?: number;
  onStatusChange?: (status: RelaySessionStatus) => void;
}

/** The WebSocket surface this module uses (enough for a fake in tests). */
export interface MinimalWebSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: string,
    listener: (event: { data?: string }) => void,
  ): void;
  removeEventListener(
    type: string,
    listener: (event: { data?: string }) => void,
  ): void;
}

const DEFAULT_AUTH_GRACE_MS = 1_000;
/** A publish fails with a timeout if the relay answers no OK/FAILED by then. */
const PUBLISH_ACK_TIMEOUT_MS = 15_000;

function defaultReconnectDelay(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 15_000);
}

interface ActiveSubscription {
  filter: NostrFilter;
  options: SubscribeOptions;
}

type PendingMessage = string;

export class RelaySession {
  readonly wsUrl: string;
  private readonly factory: (url: string) => MinimalWebSocket;
  private readonly signAuthEvent: NonNullable<
    RelaySessionOptions["signAuthEvent"]
  >;
  private readonly reconnectDelayMs: (attempt: number) => number;
  private readonly authGraceMs: number;
  private readonly onStatusChange?: (status: RelaySessionStatus) => void;

  private socket: MinimalWebSocket | null = null;
  private statusValue: RelaySessionStatus = "idle";
  private nextSubId = 0;
  /** subId → subscription (only currently-open relay subscriptions). */
  private readonly openSubs = new Map<string, ActiveSubscription>();
  /** User-facing handles: subId per unsubscribe token (stable across replays). */
  private readonly activeSubs = new Map<string, ActiveSubscription>();
  /** Messages waiting for AUTH completion on the current socket. */
  private pending: PendingMessage[] = [];
  private authenticated = false;
  /**
   * True only when the RELAY accepted our AUTH — the auth-grace path sets
   * `authenticated` without it, and a challenge arriving after grace must
   * still be answered (the relay may have closed our pre-auth REQs).
   */
  private authedByRelay = false;
  private authTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private manualClose = false;
  /** Resolvers for EVENTs awaiting OK, by event id. */
  private readonly publishWaiters = new Map<
    string,
    { resolve: (ok: boolean, message: string) => void }
  >();

  constructor(options: RelaySessionOptions) {
    this.wsUrl = options.wsUrl;
    this.factory =
      options.webSocketFactory ??
      ((url) => new WebSocket(url) as unknown as MinimalWebSocket);
    this.signAuthEvent =
      options.signAuthEvent ??
      (async (challenge, relayUrl) =>
        defaultSignNostrEvent(
          authEventTemplate(challenge, relayUrl, getAuthTagJson()),
        ));
    this.reconnectDelayMs = options.reconnectDelayMs ?? defaultReconnectDelay;
    this.authGraceMs = options.authGraceMs ?? DEFAULT_AUTH_GRACE_MS;
    this.onStatusChange = options.onStatusChange;
  }

  get status(): RelaySessionStatus {
    return this.statusValue;
  }

  private setStatus(status: RelaySessionStatus): void {
    this.statusValue = status;
    this.onStatusChange?.(status);
  }

  connect(): void {
    if (this.socket && this.statusValue !== "closed") {
      return;
    }
    this.manualClose = false;
    this.setStatus(this.reconnectAttempt === 0 ? "connecting" : "reconnecting");
    this.openSocket();
  }

  private openSocket(): void {
    const socket = this.factory(this.wsUrl);
    this.socket = socket;
    this.authenticated = false;
    this.authedByRelay = false;
    this.pending = [];
    socket.addEventListener("open", this.handleOpen);
    socket.addEventListener("message", this.handleMessage);
    socket.addEventListener("close", this.handleClose);
    socket.addEventListener("error", this.handleError);
  }

  private readonly handleOpen = (): void => {
    // Give the relay a beat to send its AUTH challenge before any REQ.
    this.authTimer = setTimeout(() => this.flushPending(), this.authGraceMs);
  };

  private readonly handleMessage = (event: { data?: string }): void => {
    if (typeof event.data !== "string") {
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!Array.isArray(message) || message.length === 0) {
      return;
    }
    const [type] = message as [string];
    if (type === "AUTH") {
      void this.handleAuthChallenge(String(message[1] ?? ""));
      return;
    }
    if (type === "EVENT") {
      const subId = String(message[1] ?? "");
      const sub = this.openSubs.get(subId);
      if (sub && message[2] && typeof message[2] === "object") {
        sub.options.onEvent(message[2] as SignedNostrEvent);
      }
      return;
    }
    if (type === "EOSE") {
      const sub = this.openSubs.get(String(message[1] ?? ""));
      sub?.options.onEose?.();
      return;
    }
    if (type === "OK" || type === "FAILED") {
      // ["OK", id, bool, msg] vs ["FAILED", id, msg] — different arities.
      const ok = type === "OK" ? message[2] === true : false;
      const id = String(message[1] ?? "");
      const messageText = String(
        (type === "OK" ? message[3] : message[2]) ?? "",
      );
      const waiter = this.publishWaiters.get(id);
      if (waiter) {
        this.publishWaiters.delete(id);
        waiter.resolve(ok, messageText);
      }
      return;
    }
    if (type === "CLOSED") {
      // A REQ that raced AUTH comes back CLOSED("auth-required"); without
      // this the sub stays listed as open, the post-AUTH replay skips it,
      // and the feed is silently dead until a reconnect. Drop it from the
      // open set so the next replay re-REQs (post-AUTH or reconnect); when
      // the close says auth-required and we are already authenticated, do
      // one bounded retry — other close reasons (e.g. policy) stay closed.
      const subId = String(message[1] ?? "");
      const reason = String(message[2] ?? "");
      if (this.openSubs.has(subId)) {
        this.openSubs.delete(subId);
        if (this.authenticated && reason.includes("auth-required")) {
          setTimeout(() => {
            if (!this.openSubs.has(subId)) {
              this.replaySubscriptions();
            }
          }, 250);
        }
      }
      return;
    }
    // NOTICE / COUNT: nothing session-critical to do yet.
  };

  private async handleAuthChallenge(challenge: string): Promise<void> {
    if (this.authedByRelay) {
      return;
    }
    if (this.authTimer) {
      clearTimeout(this.authTimer);
      this.authTimer = null;
    }
    if (this.statusValue !== "closed") {
      this.setStatus("authenticating");
    }
    try {
      const event = await this.signAuthEvent(challenge, this.wsUrl);
      this.socket?.send(JSON.stringify(["AUTH", event]));
      this.authenticated = true;
      this.authedByRelay = true;
      this.setStatus("open");
      this.flushPending();
      this.replaySubscriptions();
    } catch {
      // Signer unavailable (locked): proceed unauthenticated; the relay will
      // reject protected reads and the UI surfaces that.
      this.authenticated = true;
      this.setStatus("open");
      this.flushPending();
      this.replaySubscriptions();
    }
  }

  private flushPending(): void {
    if (this.authTimer) {
      clearTimeout(this.authTimer);
      this.authTimer = null;
    }
    if (!this.authenticated) {
      // Grace expired without a challenge: relay does not require AUTH.
      this.authenticated = true;
    }
    this.setStatus("open");
    const queued = this.pending;
    this.pending = [];
    for (const message of queued) {
      this.socket?.send(message);
    }
    this.replaySubscriptions();
  }

  private replaySubscriptions(): void {
    // (Re-)REQ every active subscription not already open on this socket.
    // Skips duplicates when called twice on one socket (auth grace then a
    // late AUTH challenge) and survives reconnects after teardownSocket.
    for (const [subId, sub] of this.activeSubs) {
      if (this.openSubs.has(subId)) {
        continue;
      }
      this.openSubs.set(subId, sub);
      this.socket?.send(JSON.stringify(["REQ", subId, sub.filter]));
    }
  }

  private readonly handleClose = (): void => {
    this.teardownSocket();
    if (this.manualClose) {
      this.setStatus("closed");
      return;
    }
    const delay = this.reconnectDelayMs(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.setStatus("reconnecting");
    this.reconnectTimer = setTimeout(() => this.openSocket(), delay);
  };

  private readonly handleError = (): void => {
    // The socket will also fire close; nothing extra to do.
  };

  private teardownSocket(): void {
    if (this.authTimer) {
      clearTimeout(this.authTimer);
      this.authTimer = null;
    }
    if (this.socket) {
      this.socket.removeEventListener("open", this.handleOpen);
      this.socket.removeEventListener("message", this.handleMessage);
      this.socket.removeEventListener("close", this.handleClose);
      this.socket.removeEventListener("error", this.handleError);
      this.socket = null;
    }
    this.authenticated = false;
    this.authedByRelay = false;
    this.openSubs.clear();
    // A publish in flight when the socket drops would otherwise hang forever:
    // the EVENT is not in `pending` (it was sent), so the reconnect never
    // re-sends it and the relay's OK — if it even comes — finds no waiter.
    // Fail fast so callers can surface the error and the user can retry
    // (kind 41010 is idempotent server-side; kind 9 dedups by event id).
    for (const waiter of this.publishWaiters.values()) {
      waiter.resolve(false, "connection lost while sending");
    }
    this.publishWaiters.clear();
  }

  close(): void {
    this.manualClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.teardownSocket();
    this.socket?.close();
    for (const waiter of this.publishWaiters.values()) {
      waiter.resolve(false, "connection closed");
    }
    this.publishWaiters.clear();
    this.activeSubs.clear();
    this.setStatus("closed");
  }

  /**
   * Subscribe to a filter. Events and EOSE flow through callbacks; call the
   * returned handle to unsubscribe. Subscriptions survive reconnects.
   */
  subscribe(filter: NostrFilter, options: SubscribeOptions): Unsubscribe {
    const subId = `s${this.nextSubId++}`;
    const sub: ActiveSubscription = { filter, options };
    this.activeSubs.set(subId, sub);
    // If not yet authenticated/open, the auth handshake replays this REQ;
    // no need to queue it in `pending` (which is for writes only).
    if (this.authenticated && this.socket) {
      this.openSubs.set(subId, sub);
      this.socket.send(JSON.stringify(["REQ", subId, filter]));
    }
    return () => {
      this.activeSubs.delete(subId);
      if (this.openSubs.delete(subId)) {
        this.socket?.send(JSON.stringify(["CLOSE", subId]));
      }
    };
  }

  /**
   * Publish a signed event; resolves when the relay answers OK/FAILED.
   * Rejects only when the connection is closed and not reconnecting.
   */
  publish(event: SignedNostrEvent): Promise<{ ok: boolean; message: string }> {
    return new Promise((resolve, reject) => {
      if (this.statusValue === "closed") {
        reject(new Error("session is closed"));
        return;
      }
      const id = event.id;
      // Belt-and-braces with teardown settling waiters: a relay that stays
      // open but never answers OK/FAILED must not hang the caller forever.
      const timer = setTimeout(() => {
        this.publishWaiters.delete(id);
        resolve({ ok: false, message: "timed out waiting for the relay" });
      }, PUBLISH_ACK_TIMEOUT_MS);
      this.publishWaiters.set(id, {
        resolve: (ok, message) => {
          clearTimeout(timer);
          resolve({ ok, message });
        },
      });
      this.sendWhenReady(JSON.stringify(["EVENT", event]));
    });
  }

  private sendWhenReady(message: string): void {
    if (this.authenticated && this.socket) {
      this.socket.send(message);
    } else {
      this.pending.push(message);
    }
  }
}

/**
 * NIP-42 AUTH event template (kind 22242), optionally carrying the NIP-OA
 * `auth` tag that attests an agent key to its owner (required when the relay
 * enforces membership and the signer is an agent rather than a direct member).
 */
export function authEventTemplate(
  challenge: string,
  relayUrl: string,
  authTagJson?: string | null,
): Omit<UnsignedNostrEvent, "created_at"> {
  const tags: string[][] = [
    ["challenge", challenge],
    ["relay", relayUrl],
  ];
  if (authTagJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(authTagJson);
    } catch {
      throw new Error("Auth tag is not valid JSON.");
    }
    if (
      !Array.isArray(parsed) ||
      parsed[0] !== "auth" ||
      typeof parsed[1] !== "string"
    ) {
      throw new Error('Auth tag must be an ["auth","…"] JSON array.');
    }
    tags.push(parsed as string[]);
  }
  return {
    kind: 22242,
    tags,
    content: "",
  };
}
