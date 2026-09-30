/**
 * Where a permalink (`?m=`) lands in the channel timeline.
 *
 * Reply targets have no row in the channel timeline (replies collapse under
 * their roots), so a permalink to one lands on its ROOT row and opens that
 * row's thread — where replies render as full rows (D-043). A reply whose
 * root fell outside the buffer needs neither: the timeline renders it as an
 * orphan top-level row, so it jumps directly.
 *
 * Lifted out of `routes/repos.tsx` (web redesign Phase 3) to keep the route
 * under the file-size ceiling. Pure and import-free.
 */
export function permalinkJumpTarget(
  messages: readonly {
    id: string;
    rootId?: string | null;
    replyToId?: string | null;
  }[],
  permalinkMessageId: string | null | undefined,
): { isReply: boolean; topLevelId: string } | null {
  if (!permalinkMessageId) {
    return null;
  }
  const byId = new Map(messages.map((m) => [m.id, m]));
  let current = byId.get(permalinkMessageId);
  if (!current) {
    return null;
  }
  let topLevelId = current.id;
  for (let hops = 0; hops < 100; hops += 1) {
    const parentId = current.rootId ?? current.replyToId;
    if (!parentId) {
      break;
    }
    const parent = byId.get(parentId);
    if (!parent) {
      break;
    }
    topLevelId = parent.id;
    current = parent;
  }
  return {
    isReply: topLevelId !== permalinkMessageId,
    topLevelId,
  };
}
