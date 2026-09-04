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
}

const ProfileActionsContext = createContext<ProfileActions>({});

export function ProfileActionsProvider({
  onOpenDm,
  children,
}: ProfileActions & { children: ReactNode }) {
  const value = useMemo<ProfileActions>(() => ({ onOpenDm }), [onOpenDm]);
  return (
    <ProfileActionsContext.Provider value={value}>
      {children}
    </ProfileActionsContext.Provider>
  );
}

export function useProfileActions(): ProfileActions {
  return useContext(ProfileActionsContext);
}
