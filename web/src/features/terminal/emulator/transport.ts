/**
 * The `/ws/term` client: socket lifecycle, close codes, reconnect, keepalive
 * and the forced repaint. Ported from evie-ui `term-xterm.js` (connect,
 * scheduleReconnect, diagnoseRefusedUpgrade, forceRepaint, resetSession),
 * with the module globals turned into one instance and the chrome hooks
 * (`window.__evieTerm`, `showLoginOverlay`, `setStatus`) turned into a single
 * `onState` callback.
 *
 * Backpressure: hatch pauses its PTY read pump when this socket's
 * bufferedAmount climbs. We therefore keep NO client-side output buffer —
 * bytes go straight into xterm's own bounded write queue. Do not "fix" a
 * stall by buffering here.
 *
 * The echo trap: a PTY echoes what we write before the shell has parsed it,
 * so seeing our own keystrokes return is not evidence of liveness. Nothing
 * here treats echoed input as a readiness signal.
 */

import { splitOversizedBracketedPaste } from "./pasteUpload.ts";
import {
  backoffDelayMs,
  closeAction,
  DISABLED_POLL_MS,
  mintTermId,
  RESET_FRAME,
  resizeFrame,
  startKeepalive,
  type TermState,
  termId,
} from "./protocol.ts";

/** What hatch says when an upgrade was refused (the browser hides the HTTP status). */
export type RefusalVerdict =
  | "signed-out"
  | "forbidden"
  | "disabled"
  /** hatch answered and the terminal is ON: the refusal was transient. */
  | "enabled"
  /** hatch did not answer: a bounce or a network blip. */
  | "unknown";

export interface TermSink {
  /** Raw PTY bytes, undecoded. */
  write(bytes: Uint8Array): void;
  /** Wipe the emulator (reset(), not clear(): no remnant prompt survives). */
  reset(): void;
}

interface SocketLike {
  readyState: number;
  binaryType: string;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
}

type SocketCtor = new (url: string) => SocketLike;

interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface TransportOptions {
  /** Build the socket URL from the query (`id`, `cols`, `rows`). */
  url(query: URLSearchParams): string;
  sink: TermSink;
  /** The emulator's current grid, or null before it exists. */
  geometry(): { cols: number; rows: number } | null;
  onState(state: TermState): void;
  /** Ask hatch why an upgrade was refused (`GET /api/me`). */
  diagnose(): Promise<RefusalVerdict>;
  /** A socket just opened (refit, focus). */
  onOpen?(): void;
  WebSocketImpl?: SocketCtor;
  timers?: Timers;
}

const OPEN = 1;
const CONNECTING = 0;
/** A settled resize round-trip: btop coalesces a fast wiggle and skips the redraw. */
export const REPAINT_HOLD_MS = 550;
export const REPAINT_SHRINK_ROWS = 6;

const encoder = new TextEncoder();

export class TermTransport {
  private readonly o: TransportOptions;
  private readonly timers: Timers;
  private ws: SocketLike | null = null;
  private retries = 0;
  private retryTimer: unknown = null;
  private repaintTimer: unknown = null;
  private stopKeepalive: (() => void) | null = null;
  private resetting = false;
  private repaintOnOpen = false;
  private flagOff = false;
  private disposed = false;
  /** A terminal state (signed-out, disabled, …): nothing reconnects until retry(). */
  private halted = false;
  private everOpened = false;
  private current: TermState = "connecting";
  /** While true, the forced repaint owns the PTY geometry; refits must not resize. */
  repainting = false;

  constructor(options: TransportOptions) {
    this.o = options;
    this.timers = options.timers ?? {
      setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
      clearTimeout: (handle) =>
        globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
  }

  get state(): TermState {
    return this.current;
  }

  get open(): boolean {
    return this.ws?.readyState === OPEN;
  }

  private setState(state: TermState) {
    this.current = state;
    this.o.onState(state);
  }

  connect(): void {
    if (this.disposed || this.halted) {
      return;
    }
    if (
      this.ws &&
      (this.ws.readyState === OPEN || this.ws.readyState === CONNECTING)
    ) {
      return;
    }
    const query = new URLSearchParams({ id: termId() });
    // Size the PTY right on the FIRST attach so the shell never renders a
    // prompt at 80x24 and then reflows.
    const grid = this.o.geometry();
    if (grid && grid.cols > 0 && grid.rows > 0) {
      query.set("cols", String(grid.cols));
      query.set("rows", String(grid.rows));
    }
    const Ctor =
      this.o.WebSocketImpl ??
      (globalThis.WebSocket as unknown as SocketCtor | undefined);
    if (!Ctor) {
      this.setState("failed");
      return;
    }
    if (!this.everOpened && this.retries === 0) {
      this.setState("connecting");
    }
    let opened = false;
    const sock = new Ctor(this.o.url(query));
    sock.binaryType = "arraybuffer"; // NOT Blob: the bytes are needed synchronously
    this.ws = sock;

    sock.onopen = () => {
      opened = true;
      this.everOpened = true;
      this.stopKeepalive?.();
      this.stopKeepalive = startKeepalive(sock, () => this.ws === sock);
      this.retries = 0;
      this.flagOff = false;
      this.setState("connected");
      this.o.onOpen?.();
      if (this.repaintOnOpen) {
        this.repaintOnOpen = false;
        this.forceRepaint();
      }
    };

    sock.onmessage = (ev) => {
      // TEXT → JSON control (only `pong`). Never terminal output.
      if (typeof ev.data === "string") {
        return;
      }
      // BINARY → raw PTY bytes, straight into xterm, undecoded. Tag check,
      // not instanceof: a buffer from another realm (an injected socket
      // shim, an extension) fails instanceof and would be dropped silently.
      if (Object.prototype.toString.call(ev.data) === "[object ArrayBuffer]") {
        this.o.sink.write(new Uint8Array(ev.data as ArrayBuffer));
      } else if (ArrayBuffer.isView(ev.data)) {
        const view = ev.data;
        this.o.sink.write(
          new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
        );
      }
    };

    sock.onerror = () => {
      // onclose always follows and owns the retry/diagnosis.
    };

    sock.onclose = (ev) => {
      if (this.ws === sock) {
        this.ws = null;
      }
      this.stopKeepalive?.();
      this.stopKeepalive = null;
      if (this.disposed) {
        return;
      }
      this.handleClose(ev.code, opened);
    };
  }

  private handleClose(code: number, opened: boolean) {
    const action = closeAction(code, { opened, resetting: this.resetting });
    switch (action.kind) {
      case "soft-reset":
        // The shared shell was NOT killed. Keep the SAME id (rotating would
        // strand a PTY client server-side), wipe, and reattach.
        this.resetting = false;
        this.retries = 0;
        this.repaintOnOpen = true;
        this.o.sink.reset();
        this.setState("reconnecting");
        this.connect();
        return;
      case "hard-reset":
        // Rotate first: reusing the old id could race the teardown and attach
        // to the very session being destroyed (launch-or-ATTACH).
        this.resetting = false;
        this.retries = 0;
        mintTermId();
        this.o.sink.reset();
        this.setState("reconnecting");
        this.connect();
        return;
      case "diagnose":
        // Retry FIRST (a deploy bounce is the common case and self-heals),
        // then let hatch narrow it. The browser hides a failed upgrade's
        // status, so a 403 and a refused connection look identical here.
        this.scheduleReconnect();
        void this.diagnose();
        return;
      case "stop":
        if (action.state === "disabled") {
          this.flagOff = true;
        }
        this.halt(action.state);
        return;
      case "reconnect":
        this.scheduleReconnect();
        return;
    }
  }

  private async diagnose() {
    let verdict: RefusalVerdict;
    try {
      verdict = await this.o.diagnose();
    } catch {
      verdict = "unknown";
    }
    if (this.disposed || this.halted) {
      return;
    }
    if (verdict === "signed-out" || verdict === "forbidden") {
      // No retry storm against a login wall.
      this.halt(verdict);
      return;
    }
    if (verdict === "disabled") {
      // The ONLY case in which "disabled" is true: hatch said so. Slow-poll
      // so turning it back on recovers without a reload.
      this.flagOff = true;
      this.timers.clearTimeout(this.retryTimer);
      this.setState("disabled");
      this.retryTimer = this.timers.setTimeout(
        () => this.connect(),
        DISABLED_POLL_MS,
      );
      return;
    }
    if (verdict === "enabled" && this.flagOff) {
      // Flipped back on: a fresh start, not an inherited 8 s step.
      this.flagOff = false;
      this.retries = 0;
      this.scheduleReconnect();
    }
    // "unknown" / "enabled": transient. Leave the quiet retry in place.
  }

  private halt(state: TermState) {
    this.halted = true;
    this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.setState(state);
  }

  /** Quiet capped-backoff reconnect; the emulator is reused, so repaint on open. */
  private scheduleReconnect() {
    if (this.disposed || this.halted) {
      return;
    }
    this.repaintOnOpen = true;
    this.timers.clearTimeout(this.retryTimer);
    if (this.flagOff) {
      this.retryTimer = this.timers.setTimeout(
        () => this.connect(),
        DISABLED_POLL_MS,
      );
      return;
    }
    this.retries += 1;
    this.setState("reconnecting");
    this.retryTimer = this.timers.setTimeout(
      () => this.connect(),
      backoffDelayMs(this.retries),
    );
  }

  /** The user asked to try again (Retry, Sign in finished, Start a new shell). */
  retry(): void {
    if (this.disposed) {
      return;
    }
    this.halted = false;
    this.flagOff = false;
    this.retries = 0;
    this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.repaintOnOpen = this.everOpened;
    this.setState(this.everOpened ? "reconnecting" : "connecting");
    this.connect();
  }

  /**
   * Reset view. The SERVER decides what that means and says so with the
   * close code: 4002 on the shared session (clear + reattach; nothing is
   * killed), 4001 only in the private per-id mode.
   */
  reset(): boolean {
    if (!this.ws || this.ws.readyState !== OPEN) {
      return false;
    }
    this.resetting = true;
    this.ws.send(RESET_FRAME);
    return true;
  }

  /** Keystrokes / paste → PTY, as BINARY frames. The one input path to the wire. */
  send(data: string | Uint8Array): boolean {
    if (this.ws?.readyState !== OPEN) {
      return false;
    }
    const bytes = typeof data === "string" ? encoder.encode(data) : data;
    for (const frame of splitOversizedBracketedPaste(bytes)) {
      this.ws.send(frame);
    }
    return true;
  }

  /** A resize is only real once it is a SIGWINCH. */
  resize(cols: number, rows: number): void {
    if (this.repainting || this.ws?.readyState !== OPEN) {
      return;
    }
    this.sendResize(cols, rows);
  }

  private sendResize(cols: number, rows: number) {
    const frame = resizeFrame(cols, rows);
    if (frame && this.ws?.readyState === OPEN) {
      this.ws.send(frame);
    }
  }

  /**
   * Force herdr to a genuine full repaint after a reattach of a REUSED
   * emulator at an unchanged size: the server's resync nudge coalesces to a
   * net-zero SIGWINCH and leaves the cleared screen frame-less. Shrink, hold
   * long enough for the TUI to commit a redraw, restore.
   */
  private forceRepaint() {
    const grid = this.o.geometry();
    if (!grid || !(grid.cols > 0 && grid.rows > 3) || !this.open) {
      return;
    }
    const { cols, rows } = grid;
    const shrunk = Math.max(rows - REPAINT_SHRINK_ROWS, 3);
    if (shrunk >= rows) {
      return;
    }
    this.repainting = true;
    this.sendResize(cols, shrunk);
    this.timers.clearTimeout(this.repaintTimer);
    this.repaintTimer = this.timers.setTimeout(() => {
      this.repainting = false;
      this.sendResize(cols, rows);
    }, REPAINT_HOLD_MS);
  }

  /** Stop dead: no timer, no keepalive, no reconnect, socket closed. */
  dispose(): void {
    this.disposed = true;
    this.timers.clearTimeout(this.retryTimer);
    this.timers.clearTimeout(this.repaintTimer);
    this.stopKeepalive?.();
    this.stopKeepalive = null;
    const sock = this.ws;
    this.ws = null;
    if (sock) {
      sock.onopen = null;
      sock.onmessage = null;
      sock.onerror = null;
      sock.onclose = null;
      try {
        sock.close(1000, "client closed");
      } catch {
        // Already closing.
      }
    }
  }
}
