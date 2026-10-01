import type { Page, Route, WebSocketRoute } from "@playwright/test";

/**
 * A stand-in for crichton's hatch service (phase-7.md §5): `/api/me`,
 * `/api/herdr`, `/api/host-stats` over HTTP, and `/ws/term` as a tiny PTY
 * that keeps its screen ACROSS connections — the way herdr's server keeps the
 * shell when a client goes — so "reset view, the session survives" is
 * something the test can see rather than assume.
 *
 * The page finds it through the `buzz:hatch-url` override; every response
 * carries the exact-origin credentialed CORS headers hatch sends.
 */

export const HATCH = "https://hatch.e2e.test/";

export type MeMode = "ok" | "signed-out" | "forbidden" | "disabled";

const ESC = "\x1b";
const dim = (s: string) => `${ESC}[90m${s}${ESC}[0m`;
const green = (s: string) => `${ESC}[32m${s}${ESC}[0m`;
const blue = (s: string) => `${ESC}[34m${s}${ESC}[0m`;
const yellow = (s: string) => `${ESC}[33m${s}${ESC}[0m`;
const addLine = green;

/** What herdr's shared session already shows when a client attaches. */
const TRANSCRIPT = [
  `${dim("❯")} redesign the vitals block: one Claude bar, runway from recent pace`,
  "",
  `${green("●")} Reading ${blue("web/src/features/usage/lib/usageHub.ts")}`,
  `${green("●")} Reading ${blue("web/src/features/usage/ui/ClaudePaceCard.tsx")}`,
  dim("  ⎿ Read 307 lines"),
  "",
  "● The hub sends usedFraction and resetsAt per account. Runway needs a burn",
  "  rate: average use per active hour over 48h of quota samples.",
  "",
  `${green("●")} Update(${blue("web/src/features/usage/lib/runway.ts")})`,
  dim("  ⎿ Added 4 lines"),
  addLine(
    "     12 + export function poolRunway(accounts: PaceAccount[], perHour: number) {",
  ),
  addLine(
    "     13 +   const free = accounts.reduce((n, a) => n + 1 - (a.usedFraction ?? 1), 0);",
  ),
  addLine(
    "     14 +   return perHour > 0 ? free / accounts.length / perHour : null;",
  ),
  addLine("     15 + }"),
  "",
  `${green("●")} Bash(cd web && pnpm test -- runway)`,
  `${dim("  ⎿ ✔ poolRunway: 45% free at 16% per active hour is 2.8h")}   ${green("3 passed")}`,
  "",
  `${yellow("✻ Brewing…")} ${dim("(2m 14s · ↓ 6.1k tokens · thinking)")}`,
  "",
].join("\r\n");

const PROMPT = `${dim("~/projects/buzz")} ${green("❯")} `;

export interface HatchMock {
  /** Route `/ws/term` — call AFTER installMockRelay (see the note inside). */
  routeSocket(): Promise<void>;
  /** Every /ws/term connection, in order, with its query. */
  connections: Array<{
    id: string | null;
    cols: string | null;
    rows: string | null;
  }>;
  /** Text control frames received (resize, reset, ping). */
  controls: Array<Record<string, unknown>>;
  /** Every BINARY frame the page sent, as bytes. */
  inputs: Buffer[];
  setMe(mode: MeMode): void;
  /** Close every live terminal socket with `code` (4004 = kill switch). */
  closeAll(code: number, reason: string): void;
}

export async function installHatchMock(
  page: Page,
  options: { me?: MeMode; herdrRunning?: boolean } = {},
): Promise<HatchMock> {
  let me: MeMode = options.me ?? "ok";
  const connections: HatchMock["connections"] = [];
  const controls: HatchMock["controls"] = [];
  const inputs: Buffer[] = [];
  const live = new Set<WebSocketRoute>();
  // The SESSION's screen: survives every client.
  let screen = `${TRANSCRIPT}\r\n${PROMPT}`;

  await page.addInitScript((url) => {
    localStorage.setItem("buzz:hatch-url", url);
  }, HATCH);

  const cors = (route: Route) => {
    const origin = route.request().headers().origin ?? "";
    return {
      "access-control-allow-origin": origin,
      "access-control-allow-credentials": "true",
      vary: "Origin",
    };
  };
  const json = (route: Route, status: number, body: unknown) =>
    route.fulfill({
      status,
      contentType: "application/json",
      headers: cors(route),
      body: JSON.stringify(body),
    });

  await page.route(`${HATCH}api/me`, (route) => {
    if (me === "signed-out")
      return json(route, 401, { error: "unauthenticated" });
    if (me === "forbidden")
      return json(route, 403, { error: "not_authorized" });
    return json(route, 200, {
      email: "sam@example.test",
      terminal:
        me === "disabled"
          ? { enabled: false, reason: "runtime_file" }
          : { enabled: true },
      session: { name: "default", shared: true },
    });
  });

  // Like hatch: every /api/* route sits behind the same session gate.
  const gate = (route: Route) =>
    me === "signed-out"
      ? json(route, 401, { error: "unauthenticated" })
      : me === "forbidden"
        ? json(route, 403, { error: "not_authorized" })
        : null;

  await page.route(
    `${HATCH}api/herdr`,
    (route) =>
      gate(route) ??
      json(
        route,
        200,
        options.herdrRunning === false
          ? { v: 1, running: false, session: "default" }
          : {
              v: 1,
              running: true,
              session: "default",
              protocol: 16,
              version: "0.7.4",
              capabilities: { focus: false },
              workspaces: [
                {
                  id: "w1",
                  label: "buzz",
                  number: 1,
                  focused: true,
                  status: "working",
                },
                {
                  id: "w2",
                  label: "evie-ui",
                  number: 2,
                  focused: false,
                  status: "idle",
                },
                {
                  id: "w3",
                  label: "stash",
                  number: 3,
                  focused: false,
                  status: "blocked",
                },
              ],
              tabs: [
                {
                  id: "w1:t1",
                  workspaceId: "w1",
                  label: "Vitals redesign",
                  number: 1,
                  focused: true,
                  status: "working",
                },
                {
                  id: "w1:t2",
                  workspaceId: "w1",
                  label: "jitter QA",
                  number: 2,
                  focused: false,
                  status: "done",
                },
                {
                  id: "w1:t3",
                  workspaceId: "w1",
                  label: "codex",
                  number: 3,
                  focused: false,
                  status: "blocked",
                },
                {
                  id: "w2:t1",
                  workspaceId: "w2",
                  label: "term drawer gap",
                  number: 1,
                  focused: false,
                  status: "done",
                },
                {
                  id: "w3:t1",
                  workspaceId: "w3",
                  label: "parity walk",
                  number: 1,
                  focused: false,
                  status: "blocked",
                },
              ],
              agents: [
                {
                  id: "a1",
                  label: "Vitals redesign",
                  workspaceId: "w1",
                  tabId: "w1:t1",
                  agent: "claude",
                  status: "working",
                },
                {
                  id: "a2",
                  label: "jitter QA",
                  workspaceId: "w1",
                  tabId: "w1:t2",
                  agent: "claude",
                  status: "done",
                },
                {
                  id: "a3",
                  label: "parity walk",
                  workspaceId: "w3",
                  tabId: "w3:t1",
                  agent: "codex",
                  status: "blocked",
                },
                {
                  id: "a4",
                  label: "term drawer gap",
                  workspaceId: "w2",
                  tabId: "w2:t1",
                  agent: "claude",
                  status: "done",
                },
              ],
            },
      ),
  );

  await page.route(
    `${HATCH}api/host-stats`,
    (route) =>
      gate(route) ??
      json(route, 200, {
        v: 1,
        host: "crichton",
        sampledAt: new Date().toISOString(),
        uptimeSec: 12 * 86_400 + 4 * 3_600,
        load: [5.2, 3.9, 3.4],
        cpu: { percent: 38 },
        gpu: { percent: 71, renderer: 58, tiler: 9, top: null },
        mem: {
          usedBytes: 41.2 * 1024 ** 3,
          totalBytes: 64 * 1024 ** 3,
          percent: 64.4,
          pressure: "normal",
        },
        disks: [
          {
            name: "Data",
            mount: "/System/Volumes/Data",
            kind: "internal",
            readOnly: false,
            totalBytes: 1.95e12,
            usedBytes: 1.21e12,
            freeBytes: 0.74e12,
            percent: 62,
          },
          {
            name: "crichton-backups",
            mount: "/Volumes/crichton-backups",
            kind: "external",
            readOnly: false,
            totalBytes: 2e12,
            usedBytes: 1.68e12,
            freeBytes: 0.32e12,
            percent: 84,
          },
        ],
        primaryDisk: "/System/Volumes/Data",
        services: {
          up: 6,
          total: 6,
          items: [
            {
              name: "relay",
              kind: "docker",
              up: true,
              startedAt: new Date(Date.now() - 9 * 86_400_000).toISOString(),
            },
            {
              name: "tts bridge",
              kind: "launchd",
              up: true,
              startedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
            },
          ],
        },
      }),
  );

  // Registered by the caller AFTER the relay mock: page routes are checked
  // newest first, and mockRelay's `/.*/` would otherwise swallow this socket
  // (it "connects" and stays silent — a terminal that is connected and empty).
  const routeSocket = () =>
    page.routeWebSocket(/^wss:\/\/hatch\.e2e\.test\/ws\/term/, (ws) => {
      const url = new URL(ws.url());
      connections.push({
        id: url.searchParams.get("id"),
        cols: url.searchParams.get("cols"),
        rows: url.searchParams.get("rows"),
      });
      if (me !== "ok") {
        // hatch refuses the upgrade; the closest a route can get is an
        // immediate close (4004 for the kill switch).
        void ws.close({
          code: me === "disabled" ? 4004 : 1008,
          reason: "refused",
        });
        return;
      }
      live.add(ws);
      let line = "";
      const out = (text: string) => {
        screen += text;
        ws.send(Buffer.from(text, "utf8"));
      };
      // Attach: hatch clears and herdr repaints the session's screen.
      ws.send(Buffer.from(`${ESC}[2J${ESC}[H${screen}`, "utf8"));
      ws.onMessage((message) => {
        if (typeof message === "string") {
          let frame: Record<string, unknown>;
          try {
            frame = JSON.parse(message) as Record<string, unknown>;
          } catch {
            return;
          }
          controls.push(frame);
          if (frame.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
          if (frame.type === "reset") {
            live.delete(ws);
            ws.close({ code: 4002, reason: "soft reset (shared session)" });
          }
          return;
        }
        inputs.push(Buffer.from(message));
        for (const ch of message.toString("utf8")) {
          if (ch === "\r") {
            const command = line.trim();
            line = "";
            if (command.startsWith("echo ")) {
              out(`\r\n${command.slice(5)}\r\n${PROMPT}`);
            } else {
              out(`\r\n${PROMPT}`);
            }
          } else if (ch === "\x7f") {
            if (line.length > 0) {
              line = line.slice(0, -1);
              out("\b \b");
            }
          } else if (ch >= " ") {
            line += ch;
            out(ch);
          }
        }
      });
      ws.onClose(() => live.delete(ws));
    });

  return {
    routeSocket,
    connections,
    controls,
    inputs,
    setMe(mode) {
      me = mode;
    },
    closeAll(code, reason) {
      for (const ws of live) {
        void ws.close({ code, reason });
      }
      live.clear();
    },
  };
}

/** The visible terminal buffer, through the element-scoped emulator handle. */
export async function terminalText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const mount = document.querySelector('[data-testid="terminal-mount"]') as
      | (HTMLElement & { buzzTerminal?: { text(): string } })
      | null;
    return mount?.buzzTerminal?.text() ?? "";
  });
}
