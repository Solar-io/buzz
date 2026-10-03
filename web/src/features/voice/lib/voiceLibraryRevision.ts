let version = 0;
const listeners = new Set<() => void>();

/** Shared invalidation for every mounted picker/card after a successful edit. */
export function invalidateVoiceLibrary(): void {
  version += 1;
  for (const listener of listeners) listener();
}
export function voiceLibraryVersion(): number {
  return version;
}
export function subscribeVoiceLibrary(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
