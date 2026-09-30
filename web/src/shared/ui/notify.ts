/**
 * The redesign's toast variants (phase-1 §5): message, agent-done, needs-you,
 * feedback-due and send-error. Each is a pure SPEC (what it says, how long it
 * stays, what it offers) rendered by `BuzzToast` through `toast.custom`.
 * The ~220 existing `toast.*` calls stay on sonner's default renderer, which
 * `shared/ui/sonner.tsx` restyles to the same surface.
 *
 * Rules the specs encode:
 * - Message and agent-done dismiss themselves after 6 s and carry a timer
 *   line; everything that needs a decision stays until acted on.
 * - A send error shows the relay's text VERBATIM — AGENTS.md's send-path
 *   trap: `publish()` resolves `{ok:false}` with the relay's verdict in
 *   `message`, and that verdict is the whole diagnosis.
 * - No control that lies: a toast offers only actions that exist today.
 */

import { createElement } from "react";
import { toast } from "sonner";
import { BuzzToast } from "./BuzzToast.tsx";

/** Message / agent-done lifetime (MessageToasts' MESSAGE_TOAST_DURATION_MS). */
export const AUTO_DISMISS_MS = 6_000;
/** Sonner treats Infinity as "until dismissed". */
export const STICKY = Number.POSITIVE_INFINITY;

export type ToastVariant =
  | "message"
  | "agentDone"
  | "needsYou"
  | "feedbackDue"
  | "sendError";

export type ToastIcon =
  | { kind: "done" }
  | { kind: "error" }
  | { kind: "feedback" }
  | { kind: "workflow" }
  | {
      kind: "avatar";
      label: string;
      seed: string;
      agent: boolean;
      ring: "need" | "idle";
    };

export interface ToastAction {
  label: string;
  primary?: boolean;
  onClick: () => void;
}

export interface ToastSpec {
  variant: ToastVariant;
  /** Bold lead, then plain rest: "**Gilfoyle** finished a turn". */
  lead: string;
  rest?: string;
  /** Monospace meta line under the title (channel, relay verdict…). */
  meta?: string;
  /** Up to two lines of body text. */
  body?: string;
  /** The body is an AI summary (shows the AI tag). */
  ai?: boolean;
  icon: ToastIcon;
  actions: ToastAction[];
  duration: number;
  /** Draw the draining timer line (auto-dismissing variants only). */
  timer: boolean;
  role: "status" | "alert";
}

export function messageSpec(input: {
  sender: string;
  senderPubkey: string;
  agent: boolean;
  context: string;
  preview: string;
  onOpen: () => void;
}): ToastSpec {
  return {
    variant: "message",
    lead: input.sender,
    meta: input.context,
    body: input.preview,
    icon: {
      kind: "avatar",
      label: input.sender,
      seed: input.senderPubkey,
      agent: input.agent,
      ring: "idle",
    },
    actions: [{ label: "Open", onClick: input.onOpen }],
    duration: AUTO_DISMISS_MS,
    timer: true,
    role: "status",
  };
}

export function agentDoneSpec(input: {
  agent: string;
  meta: string;
  onOpen: () => void;
}): ToastSpec {
  return {
    variant: "agentDone",
    lead: input.agent,
    rest: "finished a turn",
    meta: input.meta,
    icon: { kind: "done" },
    actions: [{ label: "Open", onClick: input.onOpen }],
    duration: AUTO_DISMISS_MS,
    timer: true,
    role: "status",
  };
}

export function needsYouSpec(input: {
  lead: string;
  rest: string;
  meta: string;
  /** The asker's pubkey; null for a relay-authored workflow approval. */
  seed: string | null;
  agent: boolean;
  primary: ToastAction;
  secondary?: ToastAction;
}): ToastSpec {
  return {
    variant: "needsYou",
    lead: input.lead,
    rest: input.rest,
    meta: input.meta,
    icon:
      input.seed === null
        ? { kind: "workflow" }
        : {
            kind: "avatar",
            label: input.lead,
            seed: input.seed,
            agent: input.agent,
            ring: "need",
          },
    actions: [
      { ...input.primary, primary: true },
      ...(input.secondary ? [input.secondary] : []),
    ],
    duration: STICKY,
    timer: false,
    role: "status",
  };
}

export function feedbackDueSpec(input: {
  context: string;
  body: string;
  ai: boolean;
  onOpen: () => void;
  onSnooze?: () => void;
}): ToastSpec {
  return {
    variant: "feedbackDue",
    lead: "Feedback due",
    rest: input.context ? `· ${input.context}` : undefined,
    body: input.body,
    ai: input.ai,
    icon: { kind: "feedback" },
    actions: [
      { label: "Open", onClick: input.onOpen },
      ...(input.onSnooze
        ? [{ label: "Snooze 1h", onClick: input.onSnooze }]
        : []),
    ],
    duration: STICKY,
    timer: false,
    role: "status",
  };
}

export function sendErrorSpec(input: {
  /** `result.message` exactly as the relay sent it. */
  message: string;
  onRetry: () => void;
  onCopy: () => void;
}): ToastSpec {
  return {
    variant: "sendError",
    lead: "Message not sent",
    meta: input.message,
    icon: { kind: "error" },
    actions: [
      { label: "Retry", primary: true, onClick: input.onRetry },
      { label: "Copy error", onClick: input.onCopy },
    ],
    duration: STICKY,
    timer: false,
    role: "alert",
  };
}

/** Show a spec; returns sonner's id. */
export function showToast(spec: ToastSpec, id?: string): string | number {
  return toast.custom(
    (toastId) => createElement(BuzzToast, { spec, toastId }),
    { duration: spec.duration, id },
  );
}

/** The variant entry points the app calls. */
export const notify = {
  message: (input: Parameters<typeof messageSpec>[0]) =>
    showToast(messageSpec(input)),
  agentDone: (input: Parameters<typeof agentDoneSpec>[0]) =>
    showToast(agentDoneSpec(input)),
  needsYou: (input: Parameters<typeof needsYouSpec>[0], id?: string) =>
    showToast(needsYouSpec(input), id),
  feedbackDue: (input: Parameters<typeof feedbackDueSpec>[0], id?: string) =>
    showToast(feedbackDueSpec(input), id),
  sendError: (input: Parameters<typeof sendErrorSpec>[0]) =>
    showToast(sendErrorSpec(input)),
  /**
   * A failed send, from whatever the send path threw or returned. `retry` is
   * a ref to the CURRENT send function — the composer's text may have changed
   * by the time Retry is clicked, and a captured closure would resend the old
   * draft.
   */
  sendFailure: (error: unknown, retry: { current: () => unknown }) => {
    const message = sendFailureMessage(error);
    return showToast(
      sendErrorSpec({
        message,
        onRetry: () => void retry.current(),
        onCopy: () => void navigator.clipboard?.writeText(message),
      }),
    );
  },
};

/** The relay's verdict, verbatim; a fixed line only when there is none. */
export function sendFailureMessage(error: unknown): string {
  if (error instanceof Error && error.message !== "") {
    return error.message;
  }
  return typeof error === "string" && error !== ""
    ? error
    : "Could not send the message.";
}

// The composer imports its toasts from here so a send failure and the older
// one-line toasts come from one module.
export { toast };
