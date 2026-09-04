/**
 * First-run orientation for the web client.
 *
 * The desktop's onboarding is five screens long because most of it is machine
 * setup: generating a key into the OS keychain, discovering ACP runtimes on
 * disk, choosing a default provider, pairing a phone through a sidecar relay.
 * A tab can do none of that. What it CAN do is the part the desktop flow was
 * really protecting — making sure a new identity does not sit there nameless
 * and with no way back if the browser is cleared.
 *
 * So this is a checklist rather than a wizard: nothing here blocks, every item
 * is reachable from where the user already is, and it derives its state from
 * facts rather than from a "did onboarding" flag. Deriving is what keeps it
 * honest — the "back up your key" item un-ticks itself if you later clear the
 * backup, and no stale completion marker can claim otherwise.
 *
 * Import-free so `node --test` can load it.
 */

export type ChecklistItemId =
  | "profile"
  | "backup"
  | "notifications"
  | "theme"
  | "channel";

export interface ChecklistFacts {
  /** kind:0 carries a display name (or the extension supplied one). */
  hasDisplayName: boolean;
  /** An encrypted backup has been created and downloaded on this device. */
  hasKeyBackup: boolean;
  /** Notification permission is decided — granted OR explicitly denied. */
  notificationsDecided: boolean;
  /** The user has picked a theme rather than sitting on the default. */
  themeChosen: boolean;
  /** The viewer is a member of at least one channel. */
  inAChannel: boolean;
  /** A key that lives only in this browser — an extension key needs no backup. */
  usesLocalKey: boolean;
}

export interface ChecklistItem {
  id: ChecklistItemId;
  title: string;
  body: string;
  /** Call to action. */
  action: string;
  done: boolean;
  /**
   * True when skipping this leaves the user unable to recover — the only item
   * the UI is entitled to shout about.
   */
  critical: boolean;
}

/**
 * Derive the checklist from facts.
 *
 * The key backup is only listed for a locally-stored key. A NIP-07 extension
 * holds the key itself and has its own backup story, so telling an extension
 * user to export a key Buzz does not have would be advice they cannot follow.
 */
export function buildChecklist(facts: ChecklistFacts): ChecklistItem[] {
  const items: ChecklistItem[] = [
    {
      id: "profile",
      title: "Say who you are",
      body: "Without a display name you show up as a truncated key, and mentions are hard to read.",
      action: "Edit profile",
      done: facts.hasDisplayName,
      critical: false,
    },
  ];

  if (facts.usesLocalKey) {
    items.push({
      id: "backup",
      title: "Back up your key",
      body: "Your key lives in this browser's storage and nowhere else. Clearing site data, a private window closing, or a wiped profile takes the identity with it. An encrypted backup is the only way back.",
      action: "Create a backup",
      done: facts.hasKeyBackup,
      critical: true,
    });
  }

  items.push(
    {
      id: "channel",
      title: "Join a conversation",
      body: "Open a channel from the sidebar, or claim an invite link to join a community.",
      action: "Browse channels",
      done: facts.inAChannel,
      critical: false,
    },
    {
      id: "notifications",
      title: "Decide about notifications",
      body: "Buzz can alert you when a message arrives in a background tab. The browser only asks once, from a real click.",
      action: "Choose",
      done: facts.notificationsDecided,
      critical: false,
    },
    {
      id: "theme",
      title: "Pick a theme",
      body: "Every colour in the interface derives from the theme you choose.",
      action: "Appearance",
      done: facts.themeChosen,
      critical: false,
    },
  );

  return items;
}

export interface ChecklistProgress {
  done: number;
  total: number;
  /** Complete when every item is done. */
  complete: boolean;
  /** Any unfinished item that would lose the identity. */
  hasOutstandingCritical: boolean;
}

export function checklistProgress(items: ChecklistItem[]): ChecklistProgress {
  const done = items.filter((item) => item.done).length;
  return {
    done,
    total: items.length,
    complete: items.length > 0 && done === items.length,
    hasOutstandingCritical: items.some((item) => item.critical && !item.done),
  };
}

/**
 * Whether to surface the checklist unprompted.
 *
 * Two rules, and the second is the one that matters: an explicit dismissal is
 * honoured EXCEPT while a critical item is outstanding. Someone who dismissed
 * the panel before backing up their key has not solved the problem, and the
 * one thing this feature exists to prevent is a silently unrecoverable
 * identity. Everything else stays dismissible for good.
 */
export function shouldShowChecklist(input: {
  dismissed: boolean;
  progress: ChecklistProgress;
}): boolean {
  if (input.progress.complete) return false;
  if (input.progress.hasOutstandingCritical) return true;
  return !input.dismissed;
}
