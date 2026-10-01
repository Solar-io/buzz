import {
  ChevronLeft,
  Keyboard,
  Maximize2,
  Minimize2,
  RotateCcw,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "@/shared/lib/cn";
import type { TerminalHandle } from "../emulator/boot.ts";
import type { TermState } from "../emulator/protocol.ts";
import type { RefusalVerdict } from "../emulator/transport.ts";
import { fetchMe, uploadForTerminal } from "../lib/hatchClient.ts";
import { hatchUrl, hatchWsUrl } from "../lib/hatchConfig.ts";
import { herdrView } from "../lib/herdrView.ts";
import { useHatchSession, useHerdr } from "../useHatch.ts";
import { useKeyboardInset, useMediaQuery } from "../useViewport.ts";
import { KeyBar } from "./KeyBar";
import { TerminalRail, TerminalTabs } from "./TerminalRail";
import {
  ConnectionPill,
  type PageState,
  TerminalStatus,
} from "./TerminalStatus";
import { Xterm } from "./Xterm";

/**
 * Terminal (`?view=terminal`; Terminal + PhoneTerminal artboards): herdr on
 * crichton through hatch. Shown only when a hatch URL is configured; the nav
 * row hides otherwise, and a stale link lands here on a plain notice.
 */
export function TerminalPage({ onBack }: { onBack: () => void }) {
  const base = hatchUrl();
  if (!base) {
    return (
      <div className="grid h-full place-items-center p-6 text-sm text-muted-foreground">
        The terminal isn't set up in this build.
      </div>
    );
  }
  return <TerminalScreen base={base} onBack={onBack} />;
}

const STOPPED: ReadonlySet<TermState> = new Set([
  "signed-out",
  "forbidden",
  "disabled",
]);

function TerminalScreen({
  base,
  onBack,
}: {
  base: string;
  onBack: () => void;
}) {
  const session = useHatchSession(base);
  const sessionState = session.state;
  const me = sessionState.kind === "ok" ? sessionState.data : null;
  const [termState, setTermState] = useState<TermState>("connecting");
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const [keyboardUp, setKeyboardUp] = useState(false);
  const [keyBarOpen, setKeyBarOpen] = useState(false);
  const [notice, setNotice] = useState<{
    text: string;
    tone: "info" | "error";
  } | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const handle = useRef<TerminalHandle | null>(null);
  const root = useRef<HTMLDivElement | null>(null);

  const phone = useMediaQuery("(width < 48rem)", false);
  const wide = useMediaQuery("(min-width: 64rem)");
  const coarse = useMediaQuery("(pointer: coarse)", false);
  const inset = useKeyboardInset(phone);

  const herdr = useHerdr(base, sessionState.kind === "ok");
  const view = useMemo(
    () =>
      herdr.snapshot?.running && !herdr.snapshot.unsupported
        ? herdrView(herdr.snapshot)
        : null,
    [herdr.snapshot],
  );

  // The gate: a socket only makes sense once hatch says who we are and that
  // the terminal is on. Anything else is shown in place of the emulator.
  const gate: PageState | null =
    sessionState.kind === "loading"
      ? "checking"
      : sessionState.kind === "signed-out"
        ? "signed-out"
        : sessionState.kind === "forbidden"
          ? "forbidden"
          : sessionState.kind === "unreachable"
            ? "unreachable"
            : sessionState.data.terminal.enabled
              ? null
              : "disabled";
  const pageState: PageState = gate ?? termState;
  const emulatorMounted = gate === null;

  // The socket diagnosed a refusal (or hatch closed 4004): sync the gate.
  const { refresh, setOnSignedIn, signIn } = session;
  useEffect(() => {
    if (STOPPED.has(termState)) void refresh();
  }, [termState, refresh]);
  // While the gate holds the screen there is no socket; the next mount
  // starts from "connecting", not from the state that closed the last one.
  useEffect(() => {
    if (gate !== null) setTermState("connecting");
  }, [gate]);
  useEffect(() => {
    setOnSignedIn(() => handle.current?.retry());
    return () => setOnSignedIn(null);
  }, [setOnSignedIn]);

  useEffect(() => {
    const onChange = () =>
      setFullscreen(document.fullscreenElement === root.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const diagnose = useCallback(async (): Promise<RefusalVerdict> => {
    const result = await fetchMe(base);
    if (result.kind === "signed-out" || result.kind === "forbidden")
      return result.kind;
    if (result.kind === "ok")
      return result.data.terminal.enabled ? "enabled" : "disabled";
    return "unknown";
  }, [base]);

  const act = () => {
    switch (pageState) {
      case "signed-out":
      case "forbidden":
        signIn();
        return;
      case "disabled":
      case "unreachable":
        void refresh().then((result) => {
          if (result.kind === "ok" && result.data.terminal.enabled)
            handle.current?.retry();
        });
        return;
      default:
        handle.current?.retry();
    }
  };

  const toggleKeyboard = () => {
    const next = !keyboardUp;
    setKeyboardUp(next);
    handle.current?.setSoftKeyboard(next);
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen?.();
    } else {
      void root.current?.requestFullscreen?.();
    }
  };

  const host = new URL(base).host;
  const sessionName = me?.session.name ?? "";
  const connected = pageState === "connected";
  const iconButton =
    "grid size-8 place-items-center rounded-lg border border-border bg-card text-ink-2 hover:text-foreground disabled:opacity-40";

  return (
    <div
      ref={root}
      data-testid="terminal-page"
      className="flex h-full min-h-0 flex-col bg-background text-foreground"
      style={phone && inset > 0 ? { paddingBottom: inset } : undefined}
    >
      {phone ? (
        <header className="flex shrink-0 items-center gap-1 pt-3.5 pr-2 pb-1.5 pl-1">
          <button
            type="button"
            aria-label="Back"
            onClick={onBack}
            className="grid size-11 shrink-0 place-items-center text-ink-2"
          >
            <ChevronLeft aria-hidden className="size-5.5" />
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="text-lg leading-tight font-bold">Terminal</h1>
            <p className="flex items-center gap-1.5 truncate font-mono text-2xs text-muted-foreground">
              <ConnectionDot state={pageState} />
              herdr · crichton
              {view?.focusedSpace ? ` · ${view.focusedSpace}` : ""}
            </p>
          </div>
          <button
            type="button"
            aria-label="Reset view (keeps the session)"
            title="Reset view: repaints from the shared session, nothing is killed"
            disabled={!connected}
            onClick={() => handle.current?.reset()}
            className="grid size-11 shrink-0 place-items-center rounded-xl text-ink-2 disabled:opacity-40"
          >
            <RotateCcw aria-hidden className="size-4.75" />
          </button>
        </header>
      ) : (
        <header className="flex min-h-14.5 shrink-0 items-center gap-3 border-b border-border py-2.5 pr-4 pl-5">
          <h1 className="text-lg font-bold tracking-tight">Terminal</h1>
          <span className="truncate font-mono text-xs text-muted-foreground">
            <span aria-hidden className="mr-2 text-line-2">
              |
            </span>
            herdr · crichton
            {sessionName && sessionName !== "default"
              ? ` · ${sessionName}`
              : ""}
          </span>
          <ConnectionPill state={pageState} />
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              aria-label={keyBarOpen ? "Hide key bar" : "Show key bar"}
              aria-pressed={keyBarOpen}
              title="Key bar (Esc, Tab, Ctrl, arrows)"
              onClick={() => setKeyBarOpen((open) => !open)}
              className={cn(
                iconButton,
                keyBarOpen && "bg-chip text-foreground",
              )}
            >
              <Keyboard aria-hidden className="size-3.75" />
            </button>
            <button
              type="button"
              aria-label="Reset view (keeps the session)"
              title="Reset view: repaints from the shared session, nothing is killed"
              data-testid="terminal-reset"
              disabled={!connected}
              onClick={() => handle.current?.reset()}
              className={iconButton}
            >
              <RotateCcw aria-hidden className="size-3.75" />
            </button>
            {document.fullscreenEnabled ? (
              <button
                type="button"
                aria-label={fullscreen ? "Exit full screen" : "Full screen"}
                aria-pressed={fullscreen}
                onClick={toggleFullscreen}
                className={iconButton}
              >
                {fullscreen ? (
                  <Minimize2 aria-hidden className="size-3.75" />
                ) : (
                  <Maximize2 aria-hidden className="size-3.75" />
                )}
              </button>
            ) : null}
          </div>
        </header>
      )}
      {phone ? (
        <div className="shrink-0 border-b border-border">
          <TerminalTabs tabs={view?.tabs ?? []} variant="chips" />
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1">
        {wide && !phone ? (
          <TerminalRail
            view={view}
            snapshot={herdr.snapshot}
            failed={herdr.failed}
            locked={
              sessionState.kind === "signed-out" ||
              sessionState.kind === "forbidden"
                ? "Sign in to crichton to see herdr's spaces and agents."
                : sessionState.kind === "unreachable"
                  ? "crichton isn't answering."
                  : null
            }
          />
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col bg-term">
          {phone ? null : (
            <TerminalTabs tabs={view?.tabs ?? []} variant="strip" />
          )}
          <div className="relative min-h-0 flex-1">
            {emulatorMounted ? (
              <Xterm
                className={cn(
                  "absolute inset-0 overflow-hidden",
                  phone ? "px-2.5 py-2" : "px-3.5 py-2.5",
                )}
                onHandle={(next) => {
                  handle.current = next;
                  if (next) setTermState("connecting");
                }}
                options={{
                  socketUrl: (query) => hatchWsUrl(base, query),
                  onState: setTermState,
                  diagnose,
                  upload: (file, name) => uploadForTerminal(base, file, name),
                  onNotice: (text, tone) =>
                    setNotice(text ? { text, tone } : null),
                  onCtrlChange: setCtrlArmed,
                  fontSize: phone ? 11.5 : 12.5,
                }}
              />
            ) : null}
            <TerminalStatus
              state={pageState}
              email={me?.email ?? null}
              reason={me?.terminal.reason ?? null}
              host={host}
              onAction={act}
              overlay={emulatorMounted}
            />
          </div>
          {notice ? (
            <p
              role="status"
              className={cn(
                "shrink-0 truncate border-t border-border px-4 py-1.5 font-mono text-2xs",
                notice.tone === "error" ? "text-coral-ink" : "text-term-dim",
              )}
            >
              {notice.text}
            </p>
          ) : null}
          {phone || keyBarOpen ? (
            <KeyBar
              onKey={(key) => {
                handle.current?.pressBarKey(key);
              }}
              ctrlArmed={ctrlArmed}
              onToggleCtrl={() => handle.current?.toggleCtrl()}
              keyboard={phone || coarse ? keyboardUp : undefined}
              onToggleKeyboard={toggleKeyboard}
              className={
                phone && inset === 0
                  ? "pb-[max(0.5rem,env(safe-area-inset-bottom))]"
                  : "pb-2"
              }
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ConnectionDot({ state }: { state: PageState }) {
  const tone =
    state === "connected"
      ? "bg-leaf"
      : state === "connecting" || state === "reconnecting"
        ? "bg-work motion-safe:animate-pulse"
        : state === "checking" || state === "signed-out" || state === "disabled"
          ? "bg-faint"
          : "bg-need";
  return (
    <span
      role="img"
      aria-label={state}
      data-testid="terminal-dot"
      data-state={state}
      className={cn("inline-block size-1.5 shrink-0 rounded-full", tone)}
    />
  );
}
