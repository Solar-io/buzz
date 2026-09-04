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
  /**
   * Clock for liveness bookkeeping (injectable for tests). Default Date.now.
   */
  nowMs?: () => number;
  /**
   * Cadence of the background staleness probe; 0 disables the timer (the
   * visibility/online wake triggers still apply). Default 30s.
   */
  livenessIntervalMs?: number;
  /** Delay before auth-race retry N (1-based). Default: exponential backoff. */
  authRetryDelayMs?: (attempt: number) => number;
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
/**
 * Pace between REQ opens during (re)connect replay. The relay closes a
 * connection as a slow client after sustained send-buffer backpressure
 * (grace 15); opening ~40 subscriptions at once on a large dataset hits
 * that before the socket drains. 120ms lets each sub's initial push
 * drain; 40 subs fully live in under five seconds, filling progressively.
 */
const REQ_OPEN_PACE_MS = 120;
/** Replays at or below this size open synchronously (no pacing needed). */
const UNPACED_REPLAY_MAX = 8;
/**
 * Liveness: the relay sends no WS pings, so a socket killed by laptop sleep
 * or a network change (no close event — the TCP pair is just gone) reads as
 * "connected" forever and every subscription silently stops delivering until
 * the user refreshes (live incident 2026-09-01: an afternoon of agent
 * messages arrived only after a manual reload; the desktop survived via its
 * own resume machinery). Probes below force a reconnect when the socket has
 * been silent; the post-AUTH subscription replay then backfills everything
 * the zombie missed (REQ re-fetches recent stored events regardless of when
 * they were published).
 */
const DEFAULT_LIVENESS_INTERVAL_MS = 30_000;
/** Visible tab: reconnect after this much total silence. */
const VISIBLE_STALE_MS = 60_000;
/**
 * Hidden/background tab: quiet subscriptions are normal, so only a much
 * longer silence counts as a dead socket.
 */
const BACKGROUND_STALE_MS = 10 * 60_000;

/**
 * Pure liveness decision: force a reconnect when a socket that believes it
 * is open has heard nothing for longer than the threshold for its tab state.
 */
export function shouldForceReconnect(
  lastMessageAt: number | null,
  now: number,
  tabVisible: boolean,
): boolean {
  if (lastMessageAt === null) {
    return false;
  }
  const silentFor = now - lastMessageAt;
  return silentFor >= (tabVisible ? VISIBLE_STALE_MS : BACKGROUND_STALE_MS);
}

function defaultReconnectDelay(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 15_000);
}

/**
 * Auth-race retry: the relay hard-CLOSES any REQ that arrives before it has
 * processed our AUTH frame (handlers/req.rs: "auth-required: not
 * authenticated"), and a page load fires ~8 REQs in that exact window. A
 * sub that loses the race used to get ONE 250ms retry — when that also
 * raced, the subscription died permanently and its panel silently never
 * loaded until the user refreshed (live incident 2026-09-01: "sometimes I
 * have to refresh multiple times before everything will load"). Retries
 * back off exponentially instead, bounded — after the last attempt the next
 * reconnect/replay is still the backstop.
 */
const AUTH_RETRY_MAX_ATTEMPTS = 5;
const AUTH_RETRY_BASE_DELAY_MS = 250;
const AUTH_RETRY_MAX_DELAY_MS = 4_000;

/** Delay before auth-race retry N (1-based). Pure — unit-tested. */
export function authRetryDelayMs(attempt: number): number {
  return Math.min(
    AUTH_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
    AUTH_RETRY_MAX_DELAY_MS,
  );
}

interface ActiveSubscription {
  /** Single filter, or several OR'd filters in one REQ (relay caps at 10). */
  filter: NostrFilter | NostrFilter[];
  options: SubscribeOptions;
}

/** Frame body for a REQ: one or more filters spread after the sub id. */
function reqFrame(subId: string, filter: NostrFilter | NostrFilter[]): string {
  return JSON.stringify([
    "REQ",
    subId,
    ...(Array.isArray(filter) ? filter : [filter]),
  ]);
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
  /** Pacing timers for staggered REQ replay; cleared on teardown. */
  private readonly replayPaceTimers = new Set<ReturnType<typeof setTimeout>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private manualClose = false;
  private readonly nowMs: () => number;
  private readonly livenessIntervalMs: number;
  private readonly authRetryDelayMsFn: (attempt: number) => number;
  private livenessTimer: ReturnType<typeof setInterval> | null = null;
  /** Wall-clock of the last frame received on the CURRENT socket. */
  private lastMessageAt: number | null = null;
  private wakeListenersAttached = false;
  private onlineListenerAttached = false;
  /** Auth-race retry attempt count per subId (reset on socket teardown). */
  private readonly authRetryAttempts = new Map<string, number>();
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
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.livenessIntervalMs =
      options.livenessIntervalMs ?? DEFAULT_LIVENESS_INTERVAL_MS;
    this.authRetryDelayMsFn = options.authRetryDelayMs ?? authRetryDelayMs;
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
    this.startLiveness();
    this.setStatus(this.reconnectAttempt === 0 ? "connecting" : "reconnecting");
    this.openSocket();
  }

  /**
   * Liveness machinery: a periodic staleness probe plus wake triggers
   * (tab visible again / network online) that probe immediately. A zombie
   * socket — killed by sleep or a network change without a close event —
   * reconnects here, and the replay machinery backfills what it missed.
   */
  private startLiveness(): void {
    if (this.livenessIntervalMs > 0 && !this.livenessTimer) {
      this.livenessTimer = setInterval(
        () => this.probeLiveness(),
        this.livenessIntervalMs,
      );
    }
    if (!this.wakeListenersAttached && typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.handleWake);
      this.wakeListenersAttached = true;
    }
    if (!this.onlineListenerAttached && typeof window !== "undefined") {
      window.addEventListener("online", this.handleWake);
      this.onlineListenerAttached = true;
    }
  }

  private stopLiveness(): void {
    if (this.livenessTimer) {
      clearInterval(this.livenessTimer);
      this.livenessTimer = null;
    }
    if (this.wakeListenersAttached && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.handleWake);
      this.wakeListenersAttached = false;
    }
    if (this.onlineListenerAttached && typeof window !== "undefined") {
      window.removeEventListener("online", this.handleWake);
      this.onlineListenerAttached = false;
    }
  }

  private readonly handleWake = (): void => {
    this.probeLiveness();
  };

  private probeLiveness(): void {
    if (this.manualClose || !this.socket) {
      return;
    }
    // No DOM (tests/SSR) counts as visible — use the shorter threshold.
    const visible = typeof document === "undefined" || !document.hidden;
    if (!shouldForceReconnect(this.lastMessageAt, this.nowMs(), visible)) {
      return;
    }
    // Socket presumed dead (silent past threshold): tear it down and dial
    // again immediately. If the relay is genuinely down, the resulting close
    // event routes into the normal backoff path.
    this.teardownSocket();
    this.reconnectAttempt = 0;
    this.setStatus("reconnecting");
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
    // Socket proven reachable — start the liveness clock from the handshake.
    this.lastMessageAt = this.nowMs();
    // Give the relay a beat to send its AUTH challenge before any REQ.
    this.authTimer = setTimeout(() => this.flushPending(), this.authGraceMs);
  };

  private readonly handleMessage = (event: { data?: string }): void => {
    if (typeof event.data !== "string") {
      return;
    }
    this.lastMessageAt = this.nowMs();
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
      // open set and schedule a backing-off retry — auth processing on the
      // relay can outlast any single fixed delay, so one retry is not
      // enough (see AUTH_RETRY_MAX_ATTEMPTS). "rate-limited" is the same
      // shape of transient failure: the relay's global handler semaphore
      // rejects REQs during fleet-wide load bursts (measured: ~46 slots of
      // headroom on a weekday morning), and without a retry the unlucky
      // sub — often the kind:0 profiles query — dies for the session,
      // which reads in the UI as names and avatars never loading. Other
      // close reasons (e.g. policy) stay closed.
      const subId = String(message[1] ?? "");
      const reason = String(message[2] ?? "");
      if (this.openSubs.has(subId)) {
        this.openSubs.delete(subId);
        const transient =
          reason.includes("auth-required") || reason.includes("rate-limited");
        if (this.authenticated && transient) {
          this.scheduleAuthRetry(subId);
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
    //
    // PACED: opening every REQ in one tight loop floods the relay's send
    // buffer faster than the socket drains — on a large dataset the relay
    // hits sustained backpressure and closes us as a slow client, the
    // reconnect replays the same flood, and the session never settles
    // (observed live: profiles never complete, sidebar goes to hex keys).
    // Spacing the opens lets each sub's initial push drain first.
    const toOpen: Array<[string, ActiveSubscription]> = [];
    for (const [subId, sub] of this.activeSubs) {
      if (!this.openSubs.has(subId)) {
        toOpen.push([subId, sub]);
      }
    }
    const openOne = (index: number) => {
      const [subId, sub] = toOpen[index];
      // Socket may have torn down mid-pace, the sub may have closed, or a
      // concurrent replay may already have opened it.
      if (
        !this.socket ||
        this.statusValue === "closed" ||
        !this.activeSubs.has(subId) ||
        this.openSubs.has(subId)
      ) {
        return;
      }
      this.openSubs.set(subId, sub);
      // A fresh REQ is a fresh chance — its auth-race budget resets with it.
      this.authRetryAttempts.delete(subId);
      this.socket.send(reqFrame(subId, sub.filter));
    };
    if (toOpen.length <= UNPACED_REPLAY_MAX) {
      for (let i = 0; i < toOpen.length; i++) {
        openOne(i);
      }
      return;
    }
    // Large replay: space EVERY open (index 0 included) so each sub's
    // initial push drains before the next arrives. Both replay triggers
    // (AUTH success and the auth-grace flush) can schedule overlapping
    // timers for the same sub — the openSubs guard in openOne makes the
    // duplicates no-ops, so exactly one REQ goes out per subscription.
    for (let i = 0; i < toOpen.length; i++) {
      const timer = setTimeout(() => {
        this.replayPaceTimers.delete(timer);
        openOne(i);
      }, i * REQ_OPEN_PACE_MS);
      this.replayPaceTimers.add(timer);
    }
  }

  /**
   * Re-REQ one subscription after a transient CLOSED — the AUTH race or a
   * relay-side rate-limit — with exponential backoff. Bounded by
   * {@link AUTH_RETRY_MAX_ATTEMPTS}; a successful REQ (via replay or here)
   * resets the counter, and teardown clears it so a new socket starts every
   * sub with a full budget.
   */
  private scheduleAuthRetry(subId: string): void {
    const sub = this.activeSubs.get(subId);
    if (!sub) {
      return;
    }
    const attempt = (this.authRetryAttempts.get(subId) ?? 0) + 1;
    if (attempt > AUTH_RETRY_MAX_ATTEMPTS) {
      return;
    }
    this.authRetryAttempts.set(subId, attempt);
    setTimeout(() => {
      const stillActive = this.activeSubs.get(subId);
      if (
        !stillActive ||
        this.openSubs.has(subId) ||
        !this.socket ||
        this.manualClose
      ) {
        return;
      }
      // The counter is NOT reset here: a sent retry that gets CLOSED again
      // must consume budget, or the cap would never bind. Only a
      // replaySubscriptions REQ (post-auth/reconnect — a genuinely fresh
      // context) or a new socket restores the full budget.
      this.openSubs.set(subId, stillActive);
      this.socket.send(reqFrame(subId, stillActive.filter));
    }, this.authRetryDelayMsFn(attempt));
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
    this.lastMessageAt = null;
    this.openSubs.clear();
    this.authRetryAttempts.clear();
    for (const timer of this.replayPaceTimers) {
      clearTimeout(timer);
    }
    this.replayPaceTimers.clear();
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
    this.stopLiveness();
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
  subscribe(
    filters: NostrFilter | NostrFilter[],
    options: SubscribeOptions,
  ): Unsubscribe {
    const subId = `s${this.nextSubId++}`;
    const sub: ActiveSubscription = { filter: filters, options };
    this.activeSubs.set(subId, sub);
    // If not yet authenticated/open, the auth handshake replays this REQ;
    // no need to queue it in `pending` (which is for writes only).
    if (this.authenticated && this.socket) {
      this.openSubs.set(subId, sub);
      this.socket.send(
        JSON.stringify([
          "REQ",
          subId,
          ...(Array.isArray(filters) ? filters : [filters]),
        ]),
      );
    }
    return () => {
      this.activeSubs.delete(subId);
      this.authRetryAttempts.delete(subId);
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
