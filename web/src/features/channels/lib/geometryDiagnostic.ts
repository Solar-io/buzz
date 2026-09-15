/**
 * Device geometry self-diagnostic (D-025 criterion 1). Pure decision logic.
 *
 * Every rig fills; only Sam's phone has ever shown the squeeze, so the
 * instrumented build makes the phone report its own DOM: when the geometry
 * is wrong, an overlay shows the visible conversation's ancestor chain,
 * viewport, and bundle hash — one screenshot is the whole deliverable.
 *
 * TRIGGER PRECISION (Dwight's condition 1): healthy composer-less states
 * are excluded BY NAME — the diagnostic arms only when a conversation view
 * is actually mounted (timeline element present). The login gate, the
 * channel picker, settings/files views, and loading frames never mount a
 * timeline, so they cannot fire it. An EMPTY conversation (timeline with
 * zero rows) is healthy only while its composer is present.
 */

export interface DiagnosticInputs {
  /** A conversation view is mounted (timeline element exists in DOM). */
  timelineMounted: boolean;
  /** Rows rendered in the timeline (0 = empty conversation — healthy with composer). */
  timelineRows: number;
  /** A visible composer (textarea in the conversation column) exists. */
  composerPresent: boolean;
  /** Timeline element height in px (-1 when not measurable). */
  timelineHeight: number;
  /** Conversation wrapper height in px (-1 when not measurable). */
  wrapperHeight: number;
}

export type DiagnosticDecision =
  | { fire: false; reason: string }
  | { fire: true; trigger: "composer-less" | "collapsed-list" };

/** Below this a mounted, row-bearing timeline is collapsed. */
export const DIAGNOSTIC_COLLAPSED_MAX = 40;
/** Wrapper must be at least this tall for "collapsed" to mean anything. */
export const DIAGNOSTIC_WRAPPER_MIN = 200;

export function decideGeometryDiagnostic(i: DiagnosticInputs): DiagnosticDecision {
  const {
    timelineMounted,
    timelineRows,
    composerPresent,
    timelineHeight,
    wrapperHeight,
  } = i;

  // Healthy composer-less states, excluded by name (Dwight's condition 1):
  if (!timelineMounted) {
    return { fire: false, reason: "no-conversation-login-picker-settings-files" };
  }
  if (timelineRows === 0 && composerPresent) {
    return { fire: false, reason: "empty-conversation-with-composer" };
  }
  // The device signature (Dwight's frame reads): message content rendered
  // with NO composer anywhere — not a normal conversation subtree at any
  // height. The tell, by name.
  if (!composerPresent) {
    return { fire: true, trigger: "composer-less" };
  }
  if (
    wrapperHeight >= DIAGNOSTIC_WRAPPER_MIN &&
    timelineHeight >= 0 &&
    timelineHeight <= DIAGNOSTIC_COLLAPSED_MAX
  ) {
    return { fire: true, trigger: "collapsed-list" };
  }
  return { fire: false, reason: "healthy" };
}

/** Compact one-line chain entry for the overlay readout. */
export function chainEntry(
  depth: number,
  tag: string,
  cls: string,
  top: number,
  height: number,
  flex: string,
  items: string,
  justify: string,
): string {
  const c = cls.split(" ").slice(0, 3).join(".").slice(0, 44);
  return `${depth} ${tag}${c ? "." + c : ""} top=${top} h=${height} flex=${flex} items=${items} justify=${justify}`;
}
