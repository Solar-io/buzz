/**
 * The seam between a timeline surface (the open card, the "Stage ready"
 * banner) and the shell that owns the Stage route and the speech player.
 *
 * A card cannot navigate or unlock audio by itself — it renders deep inside
 * the timeline, with no router and no player — and threading callbacks
 * through every timeline host would touch files that already sit at the
 * size ceiling. So the shell registers ONE launcher here, and a card calls
 * `launchStage` from inside its click handler. That matters for iOS: the
 * launcher's `unlock` runs synchronously inside the user's tap, which is the
 * only moment WebKit lets audio start.
 */

export type StageEntryMode = "live" | "replay";

export interface StageLauncher {
  /** Resume/prime audio. Called synchronously inside the gesture. */
  unlock: () => void;
  /** Navigate to the Stage overlay for this open event. */
  open: (openId: string, channelId: string, mode: StageEntryMode) => void;
}

let launcher: StageLauncher | null = null;
const entries = new Map<string, { mode: StageEntryMode; gestured: boolean }>();

/** Register the shell's launcher; returns the unregister function. */
export function setStageLauncher(next: StageLauncher): () => void {
  launcher = next;
  return () => {
    if (launcher === next) launcher = null;
  };
}

/** True when a shell is mounted that can open Stage. */
export function hasStageLauncher(): boolean {
  return launcher !== null;
}

/**
 * Open Stage from a user gesture. Unlocks audio first (inside the gesture),
 * then records how the view was entered and navigates. Returns false when
 * no shell is mounted.
 */
export function launchStage(
  openId: string,
  channelId: string,
  mode: StageEntryMode,
): boolean {
  if (!launcher) return false;
  launcher.unlock();
  entries.set(openId, { mode, gestured: true });
  launcher.open(openId, channelId, mode);
  return true;
}

/**
 * How this Stage visit was entered — read ONCE by the view. A cold link
 * (no launcher tap) is `live` and not gestured, so the view shows its
 * "Tap to start" screen.
 */
export function takeStageEntry(openId: string): {
  mode: StageEntryMode;
  gestured: boolean;
} {
  const entry = entries.get(openId) ?? { mode: "live", gestured: false };
  entries.delete(openId);
  return entry;
}
