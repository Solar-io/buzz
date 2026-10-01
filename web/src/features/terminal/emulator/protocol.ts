/**
 * The `/ws/term` wire contract, client half (phase-7.md §5.1). Ported from
 * evie-ui `app/public/js/term-xterm.js` + `core/ws-keepalive.js`; must match
 * hatch `app/web/term-hub.ts` EXACTLY.
 *
 *   BINARY frame → raw PTY bytes, verbatim, in BOTH directions. Never
 *                  decoded here: a UTF-8 codepoint straddles frames routinely,
 *                  and only xterm's own decoder carries the partial state.
 *   TEXT frame   → a small JSON control channel: resize / reset / ping.
 *
 * Pure: no DOM, no WebSocket, no timers except the keepalive's injected ones.
 */

/** Hard reset (per-id escape hatch only): rotate the id, then reconnect. */
export const TERM_CLOSE_RESET = 4001;
/** Soft reset on the SHARED session: clear the emulator, reconnect the SAME id. */
export const TERM_CLOSE_SOFT_RESET = 4002;
/** Our herdr CLIENT exited; the shell lives on in the herdr server. Back off and reconnect. */
export const TERM_CLOSE_CLIENT_EXIT = 4003;
/** hatch's runtime kill switch closed the socket. Disabled; no reconnect. */
export const TERM_CLOSE_DISABLED = 4004;
/** A private PTY exited (`exit`). */
export const TERM_CLOSE_EXITED = 1000;
/** PTY spawn failed. */
export const TERM_CLOSE_SPAWN_FAILED = 1011;
/** Shed on purpose: capacity, or we were too slow a consumer. */
export const TERM_CLOSE_CAPACITY = 1013;

/** Where the terminal is, as the page renders it. */
export type TermState =
  /** Opening the socket for the first time. */
  | "connecting"
  | "connected"
  /** Lost the socket (or never got one); a quiet backoff retry is armed. */
  | "reconnecting"
  /** hatch says 401: sign in to crichton. */
  | "signed-out"
  /** hatch says 403: this account is not on the allowlist. */
  | "forbidden"
  /** The kill switch is off (boot flag or runtime file). */
  | "disabled"
  /** 1013: at capacity or shed for backpressure. Retry is the user's call. */
  | "at-capacity"
  /** 1000: the private shell exited. A new one is the user's call. */
  | "shell-exited"
  /** 1011: the PTY could not be spawned. */
  | "failed";

/** What the transport does with a close event. */
export type CloseAction =
  /** 4002: wipe the emulator, reconnect with the same id, force a repaint. */
  | { kind: "soft-reset" }
  /** 4001 (or a reset we asked for that closed otherwise): rotate the id, wipe, reconnect. */
  | { kind: "hard-reset" }
  /** Never opened: retry quietly AND ask hatch why (/api/me). */
  | { kind: "diagnose" }
  /** A terminal state: show it, do not reconnect. */
  | { kind: "stop"; state: TermState }
  /** Transport drop or herdr-client exit: quiet backoff reconnect. */
  | { kind: "reconnect" };

/**
 * THE close-code table (§5.1), in evie's order — the order is load-bearing:
 * a soft reset must win over "never opened", and a reset we asked for must
 * never fall through to "shell exited".
 */
export function closeAction(
  code: number,
  context: { opened: boolean; resetting: boolean },
): CloseAction {
  if (code === TERM_CLOSE_SOFT_RESET) {
    return { kind: "soft-reset" };
  }
  if (code === TERM_CLOSE_RESET || context.resetting) {
    return { kind: "hard-reset" };
  }
  if (code === TERM_CLOSE_DISABLED) {
    return { kind: "stop", state: "disabled" };
  }
  if (!context.opened) {
    return { kind: "diagnose" };
  }
  if (code === TERM_CLOSE_CAPACITY) {
    return { kind: "stop", state: "at-capacity" };
  }
  if (code === TERM_CLOSE_SPAWN_FAILED) {
    return { kind: "stop", state: "failed" };
  }
  if (code === TERM_CLOSE_CLIENT_EXIT) {
    return { kind: "reconnect" };
  }
  if (code === TERM_CLOSE_EXITED) {
    return { kind: "stop", state: "shell-exited" };
  }
  return { kind: "reconnect" };
}

/** Backoff cap: 0.5 → 1 → 2 → 4 → 8 s, then held at 8 s. */
export const RECONNECT_CAP_MS = 8_000;
/** Slow re-check while the kill switch is confirmed off, so a flip recovers without a reload. */
export const DISABLED_POLL_MS = 30_000;

export function backoffDelayMs(attempt: number): number {
  return Math.min(500 * 2 ** (Math.max(attempt, 1) - 1), RECONNECT_CAP_MS);
}

/* ── the client id ───────────────────────────────────────────────────────────
 * The id no longer names the herdr session (hatch pins that server-side); it
 * is a log tag and the name source in the legacy per-id mode, where it must
 * stay in herdr's charset and short (past the kernel sun_path cap herdr
 * renders nothing). Rotated only by a HARD reset. */

export const TERM_ID_KEY = "buzz.terminal.id";
export const TERM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

interface IdStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function storage(): IdStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Storage blocked (private mode): the id still has to survive a soft reset. */
let memoryId: string | null = null;

export function mintTermId(store: IdStorage | null = storage()): string {
  const id = `t-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  memoryId = id;
  try {
    store?.setItem(TERM_ID_KEY, id);
  } catch {
    // Storage blocked: this id lives for the page only.
  }
  return id;
}

export function termId(store: IdStorage | null = storage()): string {
  let id = "";
  try {
    id = store?.getItem(TERM_ID_KEY) ?? "";
  } catch {
    id = "";
  }
  if (TERM_ID_RE.test(id)) return id;
  if (memoryId && TERM_ID_RE.test(memoryId)) return memoryId;
  return mintTermId(store);
}

/* ── control frames (TEXT) ─────────────────────────────────────────────────── */

export function resizeFrame(cols: number, rows: number): string | null {
  if (
    !Number.isFinite(cols) ||
    !Number.isFinite(rows) ||
    cols <= 0 ||
    rows <= 0
  ) {
    return null;
  }
  return JSON.stringify({ type: "resize", cols, rows });
}

export const RESET_FRAME = JSON.stringify({ type: "reset" });
export const PING_FRAME = JSON.stringify({ type: "ping" });

/* ── keepalive ───────────────────────────────────────────────────────────────
 * Bun closes a socket idle for 120 s (evie measured 594 of 670 closes as
 * 1006/inactivity before this existed). Ping every 30 s while the socket is
 * still the current one and OPEN; `isCurrent` lets it stop itself on the
 * teardown paths that never run a close handler. */

export const WS_PING_MS = 30_000;
const OPEN = 1;

export function startKeepalive(
  sock: { readyState: number; send(data: string): void },
  isCurrent: () => boolean,
  intervalMs = WS_PING_MS,
): () => void {
  let id: ReturnType<typeof setInterval> | null = setInterval(() => {
    if (id === null) {
      return;
    }
    if (!isCurrent() || sock.readyState !== OPEN) {
      stop();
      return;
    }
    try {
      sock.send(PING_FRAME);
    } catch {
      stop();
    }
  }, intervalMs);
  function stop() {
    if (id !== null) {
      clearInterval(id);
      id = null;
    }
  }
  return stop;
}
