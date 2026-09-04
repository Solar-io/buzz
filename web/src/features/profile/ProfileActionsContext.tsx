import { createContext, useContext, useMemo, type ReactNode } from "react";

/**
 * Shell-owned actions the profile card can offer.
 *
 * Opening a DM is a shell concern — `app/routes/repos.tsx` owns DM creation
 * and navigation — but the card that offers it renders deep inside the
 * timeline, under `ChannelTimeline`. Threading a callback down that path
 * would mean editing every component in between for a prop none of them use.
 * A context lets the shell wire it in one place, and leaves
 * `ChannelTimeline` untouched.
 *
 * Absent provider is a supported state: without one, the card simply does not
 * offer the action. It never renders a button that does nothing.
 */
export interface ProfileActions {
  /**
   * Open (or create) a DM with this pubkey. Omit to hide the affordance.
   */
  onOpenDm?: (pubkey: string) => void;
  /**
   * Resolve a channel id to its name, for the card's recent-activity list.
   * Omit and the list still renders — it just shows no channel labels.
   */
  channelName?: (channelId: string) => string;
  /**
   * Jump to one message. Omit and recent activity is read-only rather than
   * clickable; it never renders a row that goes nowhere.
   */
  onOpenMessage?: (channelId: string, messageId: string) => void;
}

const ProfileActionsContext = createContext<ProfileActions>({});

export function ProfileActionsProvider({
  onOpenDm,
  channelName,
  onOpenMessage,
  children,
}: ProfileActions & { children: ReactNode }) {
  const value = useMemo<ProfileActions>(
    () => ({ onOpenDm, channelName, onOpenMessage }),
    [onOpenDm, channelName, onOpenMessage],
  );
  return (
    <ProfileActionsContext.Provider value={value}>
      {children}
    </ProfileActionsContext.Provider>
  );
}

export function useProfileActions(): ProfileActions {
  return useContext(ProfileActionsContext);
}
