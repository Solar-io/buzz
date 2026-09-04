/**
 * The text of one OS notification.
 *
 * Pure and separate from the runtime because an OS notification is the one
 * surface a screenshot cannot check — it is drawn by the operating system,
 * outside the page, and outside any browser automation. Keeping the copy in a
 * function means the wording is pinned by a test even though the rendering
 * is not.
 */

/** Longer bodies are cut here; OS notification panels truncate anyway. */
export const NOTIFICATION_BODY_MAX = 140;

export interface NotificationCopyInput {
  /** Display name of the sender, or a short key when the profile is unknown. */
  authorName: string;
  /** Channel name without the `#`, or "" when the cache has not seen it. */
  channelName: string;
  isDm: boolean;
  /** The message text. */
  content: string;
  /** Groups repeat notifications from one channel into a single slot. */
  channelId: string;
}

export interface NotificationCopy {
  title: string;
  body: string;
  tag: string;
}

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) {
    return collapsed;
  }
  return `${collapsed.slice(0, max - 1).trimEnd()}…`;
}

export function notificationCopy(
  input: NotificationCopyInput,
): NotificationCopy {
  const author = input.authorName.trim() || "Someone";
  const title = input.isDm
    ? author
    : input.channelName.trim()
      ? `${author} in #${input.channelName.trim()}`
      : author;
  return {
    title,
    body: truncate(input.content, NOTIFICATION_BODY_MAX) || "Sent a message",
    tag: `buzz:${input.channelId}`,
  };
}
