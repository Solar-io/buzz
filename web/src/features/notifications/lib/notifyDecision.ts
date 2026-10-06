/**
 * The notify/skip decision for one incoming message.
 *
 * A browser gets a smaller job than the desktop: no tray, one OS
 * notification, a count in the tab title, and a sound. The whole of that job
 * hinges on a handful of booleans, so they live here as a pure function — the
 * runtime hook classifies an event, this decides, and a unit test can pin
 * every branch without a relay, a permission prompt, or a browser.
 *
 * Three outputs, not one, because each has its own gate: the title badge is
 * ours to draw and needs no permission; an OS notification needs a granted
 * permission the user may never give (or may have refused, after which the
 * page cannot re-ask); and the sound needs neither, but is the one thing a
 * muted channel withholds. Collapsing them would make a denied permission
 * silently disable the badge and the sound too.
 *
 * MUTE MEANS "NO SOUND" (the desktop's rule, 8ca8caa35): a muted channel or
 * DM still notifies and still counts toward the badge — @mentions included —
 * it just never plays a sound.
 */

/** What the viewer wants to be alerted about. */
export type NotificationMode = "all" | "mentions" | "none";

/**
 * Browser notification permission, plus the case the DOM type omits: a
 * browser (or a non-secure context) with no Notification API at all.
 */
export type NotificationPermissionState =
  | "granted"
  | "denied"
  | "default"
  | "unsupported";

/** One incoming message, already classified against the viewer. */
export interface IncomingMessage {
  /** The viewer signed it — you are never alerted about your own message. */
  fromSelf: boolean;
  /** The message p-tags the viewer: an @mention, or a DM peer tag. */
  mentionsSelf: boolean;
  /**
   * A scheduled wake from the services identity addressed to someone else
   * (see `isWakeForOthers`) — agent machinery the viewer is a bystander to.
   */
  silentWake: boolean;
  /** The message landed in a DM channel. */
  isDm: boolean;
  /** The message's channel is muted in the viewer's local channel prefs. */
  channelMuted: boolean;
  /** The message's channel is the one currently open on screen. */
  isActiveChannel: boolean;
}

/** The viewer's settings and the tab's state at the moment of arrival. */
export interface NotifyContext {
  mode: NotificationMode;
  /** Master switch for OS notifications; the badge and sound ignore it. */
  desktopEnabled: boolean;
  permission: NotificationPermissionState;
  /** `document.visibilityState === "hidden"` at the moment of arrival. */
  documentHidden: boolean;
  /** Master switch for notification sounds. */
  soundEnabled: boolean;
}

/**
 * Why the decision came out the way it did. Reported in the settings surface
 * so "nothing happened" can always be distinguished from "nothing was meant
 * to happen" — the failure mode that makes a dead notification path look
 * exactly like a quiet one.
 */
export type NotifyReason =
  | "ok"
  | "self"
  | "silent-wake"
  | "muted-everything"
  | "channel-muted"
  | "not-addressed"
  | "viewing"
  | "notifications-off"
  | "permission-default"
  | "permission-denied"
  | "unsupported";

export interface NotifyDecision {
  /** Raise a Web Notification. */
  notify: boolean;
  /** Count this message toward the document-title badge. */
  badge: boolean;
  /** Play the slot's notification sound. */
  sound: boolean;
  reason: NotifyReason;
}

const SKIP = { notify: false, badge: false, sound: false } as const;

/**
 * Decide what an arriving message earns.
 *
 * The relevance gate runs first and short-circuits EVERY output: an
 * irrelevant message is neither notified, counted, nor chimed. Only once a
 * message is relevant do the outputs diverge — the badge asks "is the tab in
 * the background", the notification asks "may we, and does the viewer want
 * it", the sound asks "is the channel muted, and are sounds on".
 */
export function decideNotification(
  message: IncomingMessage,
  context: NotifyContext,
): NotifyDecision {
  if (message.fromSelf) {
    return { ...SKIP, reason: "self" };
  }
  if (message.silentWake) {
    return { ...SKIP, reason: "silent-wake" };
  }
  if (context.mode === "none") {
    return { ...SKIP, reason: "muted-everything" };
  }
  if (context.mode === "mentions" && !message.mentionsSelf && !message.isDm) {
    return { ...SKIP, reason: "not-addressed" };
  }
  // The one rule that is easy to get backwards, so state it in full: the
  // viewer is looking at this very channel, which means the message is
  // already on screen and alerting about it is pure noise. A HIDDEN tab is
  // never "looking" — a backgrounded tab with the channel still selected is
  // exactly the case the whole feature exists for, and inverting this test
  // kills it while leaving every other case working.
  if (!context.documentHidden && message.isActiveChannel) {
    return { ...SKIP, reason: "viewing" };
  }
  // Mute is one rule everywhere (left-nav QA #6, 2026-10-05): a muted
  // conversation — channel or DM — never toasts, never pills, never raises
  // an OS notification, never counts toward a badge and never chimes. It
  // used to withhold only the sound, so a muted DM still interrupted.
  if (message.channelMuted) {
    return { ...SKIP, reason: "channel-muted" };
  }

  // The badge exists to make a BACKGROUND tab show activity; a visible tab
  // shows it in the sidebar instead.
  const badge = context.documentHidden;
  // The sound deliberately ignores permission and the desktop switch: it is how a visible tab looking at a
  // different channel, or a browser that refused notifications, still
  // tells you something arrived.
  const sound = context.soundEnabled;

  if (!context.desktopEnabled) {
    return { notify: false, badge, sound, reason: "notifications-off" };
  }
  if (context.permission === "unsupported") {
    return { notify: false, badge, sound, reason: "unsupported" };
  }
  if (context.permission === "denied") {
    return { notify: false, badge, sound, reason: "permission-denied" };
  }
  if (context.permission === "default") {
    return { notify: false, badge, sound, reason: "permission-default" };
  }
  return { notify: true, badge, sound, reason: "ok" };
}

/**
 * Human-readable form of a decision, for the settings surface's live
 * diagnostics row. Phrased as what WOULD happen, because that is the question
 * a user opening this screen is actually asking.
 */
export function describeNotifyReason(reason: NotifyReason): string {
  switch (reason) {
    case "ok":
      return "Messages will raise a notification.";
    case "self":
      return "Your own messages never notify.";
    case "silent-wake":
      return "Scheduled wakes for other members never notify.";
    case "muted-everything":
      return "Notifications are set to nothing.";
    case "channel-muted":
      return "That conversation is muted: it never alerts.";
    case "not-addressed":
      return "Only mentions and DMs notify.";
    case "viewing":
      return "You are looking at that channel.";
    case "notifications-off":
      return "Desktop notifications are switched off.";
    case "permission-default":
      return "Your browser has not been asked for permission yet.";
    case "permission-denied":
      return "Your browser is blocking notifications for this site.";
    case "unsupported":
      return "This browser does not support notifications.";
  }
}
