/**
 * Gathering the facts the checklist derives from.
 *
 * Every fact here is read from the thing itself rather than from a flag the
 * app set when it thought the step was done: the display name comes from the
 * live kind:0, the backup from the IndexedDB record keyed by pubkey, the
 * notification state from `Notification.permission`, the theme from the same
 * localStorage key the theme provider writes, the channel list from the live
 * subscription. That is what lets an item un-tick itself when the underlying
 * fact goes away.
 */

import { useEffect, useMemo, useState } from "react";

import { useChannels } from "@/features/channels/useChannels";
import { readNotificationPermission } from "@/features/notifications/lib/permission.ts";
import { useProfileMetadata } from "@/features/profile/hooks";
import { THEME_STORAGE_KEY } from "@/shared/theme/ThemeProvider";
import { ownPubkey } from "@/shared/lib/nostr-signer";

import { hasBackupFor } from "./keyBackup";
import { useSignerSource } from "./useSignerSource";
import {
  buildChecklist,
  checklistProgress,
  shouldShowChecklist,
  type ChecklistItem,
  type ChecklistProgress,
} from "./lib/onboardingChecklist.ts";

const DISMISS_KEY = "buzz.onboarding-checklist-dismissed.v1";

function readDismissed(): boolean {
  try {
    return globalThis.localStorage?.getItem(DISMISS_KEY) === "true";
  } catch {
    return false;
  }
}

function themeChosen(): boolean {
  try {
    return (globalThis.localStorage?.getItem(THEME_STORAGE_KEY) ?? "") !== "";
  } catch {
    return false;
  }
}

export interface OnboardingChecklistState {
  items: ChecklistItem[];
  progress: ChecklistProgress;
  /** Whether the panel should be offered without being asked for. */
  visible: boolean;
  dismissed: boolean;
  dismiss: () => void;
  restore: () => void;
  /** Re-read the facts that are not live subscriptions. */
  refresh: () => void;
}

export function useOnboardingChecklist(): OnboardingChecklistState {
  const [self, setSelf] = useState<string | null>(null);
  const [hasBackup, setHasBackup] = useState(false);
  const [dismissed, setDismissed] = useState(readDismissed);
  const [nonce, setNonce] = useState(0);

  const { channels } = useChannels();
  const profile = useProfileMetadata(self);
  // Reactive: the key store restores from IndexedDB after the first render, so
  // a one-shot read reports "extension" for a device that has a local key and
  // never corrects itself. See `useSignerSource` for the incident.
  const signerSource = useSignerSource();

  // Re-resolve when the signer changes: `ownPubkey()` cannot answer until the
  // key store has restored, so the first call on a remembered-key load
  // resolves against the wrong signer (or none).
  useEffect(() => {
    // An ephemeral signer is a page-lifetime identity with no profile and no
    // key worth backing up, so it has no `self` to resolve.
    if (signerSource === "ephemeral") {
      setSelf(null);
      return;
    }
    void ownPubkey().then(setSelf);
  }, [signerSource]);

  /*
   * `nonce` is the refresh handle. The backup record is written by a sibling
   * card in the same page, not by a subscription, so nothing else would tell
   * this hook that the "back up your key" item just became true.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce is the refresh handle; see above
  useEffect(() => {
    void hasBackupFor(self).then(setHasBackup);
  }, [self, nonce]);

  /*
   * `nonce` is the refresh handle. Two of the facts below — the notification
   * permission and the stored theme — are read imperatively from the browser
   * rather than subscribed to, so React has no way to know they changed.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce is the refresh handle; see above
  const items = useMemo(() => {
    // Both fields are always-present strings, so this is an `||` chain, not
    // `??`: an empty `display_name` must fall through to `name`.
    const displayName =
      profile.metadata.displayName.trim() || profile.metadata.name.trim();
    return buildChecklist({
      hasDisplayName: displayName.length > 0,
      hasKeyBackup: hasBackup,
      notificationsDecided: readNotificationPermission() !== "default",
      themeChosen: themeChosen(),
      inAChannel: channels.length > 0,
      usesLocalKey: signerSource === "local",
    });
    // `nonce` is the manual refresh handle for the non-subscription facts.
  }, [profile.metadata, hasBackup, channels.length, signerSource, nonce]);

  const progress = useMemo(() => checklistProgress(items), [items]);

  return {
    items,
    progress,
    visible: shouldShowChecklist({ dismissed, progress }),
    dismissed,
    dismiss: () => {
      try {
        globalThis.localStorage?.setItem(DISMISS_KEY, "true");
      } catch {
        // Session-only dismissal is an acceptable degradation.
      }
      setDismissed(true);
    },
    restore: () => {
      try {
        globalThis.localStorage?.removeItem(DISMISS_KEY);
      } catch {
        // Ignore.
      }
      setDismissed(false);
    },
    refresh: () => setNonce((value) => value + 1),
  };
}
