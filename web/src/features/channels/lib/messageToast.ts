/**
 * In-app message-toast copy and gating.
 *
 * Pure and separate from the toast runtime for the same reason
 * notificationCopy is: the wording and the decision are the parts a test can
 * pin, while the rendering belongs to sonner. Kept beside channelActivity
 * because both consume the same live activity feed.
 */

/** Longer previews are cut here; a toast body wraps, it does not scroll. */
export const MESSAGE_TOAST_PREVIEW_MAX = 90;

/** How long a message toast stays up (sonner default is 4000). */
export const MESSAGE_TOAST_DURATION_MS = 6000;

export interface ShouldToastMessageInput {
  /** The viewer wrote the message (another device counts too). */
  isSelf: boolean;
  /** The conversation is the one currently open on screen. */
  isViewingChannel: boolean;
  isDm: boolean;
  isMuted: boolean;
}

/**
 * Whether a live message deserves a bottom-right toast.
 *
 * - self messages never toast (you know you wrote it);
 * - the conversation on screen never toasts (you are looking at it);
 * - a muted conversation never toasts — channel or DM (left-nav QA #6: mute
 *   is one rule everywhere; a muted DM used to toast anyway).
 */
export function shouldToastMessage(input: ShouldToastMessageInput): boolean {
  if (input.isSelf) {
    return false;
  }
  if (input.isViewingChannel) {
    return false;
  }
  return !input.isMuted;
}

export interface MessageToastInput {
  /**
   * Display name of the conversation: the bare channel/forum name, or the
   * peer name for DMs (the caller formats DM names from participants).
   */
  channelName: string;
  isDm: boolean;
  /** Sender display name when known; "" when it is not. */
  senderName: string;
  /** Message text (already markdown-stripped by the activity feed). */
  preview: string;
}

export interface MessageToastCopy {
  title: string;
  description: string;
}

/**
 * Toast title + body. Channel/forum titles keep the `#name` form the channel
 * header uses; DM titles lead with the sender, falling back to the peer name
 * the sidebar shows.
 */
export function buildMessageToast(input: MessageToastInput): MessageToastCopy {
  const channel = input.channelName.trim();
  const sender = input.senderName.trim();
  const title = input.isDm
    ? sender || channel || "New message"
    : sender && channel
      ? `${sender} in #${channel}`
      : sender || (channel ? `#${channel}` : "New message");
  return {
    title,
    description:
      truncate(input.preview, MESSAGE_TOAST_PREVIEW_MAX) || "Sent a message",
  };
}

export interface MessageToastParts {
  /** Bold lead: who wrote it. */
  sender: string;
  /** Mono meta line: "#channel" or "DM". */
  context: string;
  /** Up to two lines of body. */
  preview: string;
}

/**
 * The same wording as {@link buildMessageToast}, split into the three slots
 * the redesign's toast card draws (sender / where / preview) instead of one
 * "Sender in #channel" title.
 */
export function messageToastParts(input: MessageToastInput): MessageToastParts {
  const channel = input.channelName.trim();
  const sender = input.senderName.trim();
  return {
    sender: sender || (input.isDm ? channel : "") || "New message",
    context: input.isDm ? "DM" : channel ? `#${channel}` : "",
    preview:
      truncate(input.preview, MESSAGE_TOAST_PREVIEW_MAX) || "Sent a message",
  };
}

/** Collapse whitespace, then cut to `max` chars with an ellipsis. */
function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) {
    return collapsed;
  }
  return `${collapsed.slice(0, max - 1).trimEnd()}…`;
}
