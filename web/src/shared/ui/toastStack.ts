/**
 * The toast stack's rules (Phase 1 QA, 2026-09-30).
 *
 * Three findings, one module:
 *
 * 1. On a phone the stack covered the first Work cards and ate their taps.
 *    A 390 px screen has no corner a toast can sit in without covering
 *    something, so the fix is fewer and shorter-lived toasts, not a new
 *    position: ONE toast at a time there, and the two decision toasts
 *    (needs-you, feedback-due) are not raised at all while the Work page is
 *    on screen — the row they announce is already in front of the reader.
 * 2. "N more · Clear all" belongs UNDER the last visible toast (Toasts
 *    artboard), not above the stack.
 * 3. (Previews and the approval toast live in `notify.ts` / `plainText.ts`.)
 *
 * Pure, plus one module-level flag the Work page sets — the reminder
 * notifier runs above `WorkProvider` in the tree and cannot read its context.
 */

/** Sonner's own phone breakpoint (it goes full-width below this). */
export const PHONE_TOAST_QUERY = "(max-width: 600px)";

/** Toasts on screen at once; the rest wait behind "N more · Clear all". */
export const VISIBLE_TOASTS = 3;
/** …and on a phone. */
export const VISIBLE_TOASTS_PHONE = 1;

export function visibleToastLimit(phone: boolean): number {
  return phone ? VISIBLE_TOASTS_PHONE : VISIBLE_TOASTS;
}

/** Toast variants that ask for a decision (mirrors `notify.ts`). */
export type DecisionToast = "needsYou" | "feedbackDue";

/**
 * Should this decision toast stay down?
 *
 * - needs-you: whenever ANY Work surface is on screen (the rail at lg, the
 *   Work page) — the row just appeared in the list the reader is looking at.
 * - feedback-due: only over the phone's Work page. At lg the rail can be
 *   open while the reader is deep in a conversation, and a reminder exists
 *   to interrupt; on the Work page it would land on the very row it names.
 */
export function decisionToastSuppressed(
  variant: DecisionToast,
  state: { workVisible: boolean; workPage: boolean; phone: boolean },
): boolean {
  if (variant === "needsYou") {
    return state.workVisible;
  }
  return state.phone && state.workPage;
}

/**
 * Where the stack header's top edge goes: just under the lowest visible
 * toast. `bottoms` are the visible toasts' viewport bottoms; with none there
 * is no stack to sit under.
 */
export function stackHeaderTop(
  bottoms: readonly number[],
  gap: number,
): number | null {
  if (bottoms.length === 0) {
    return null;
  }
  return Math.max(...bottoms) + gap;
}

let workPageCount = 0;

/**
 * The Work PAGE (`?view=work`) reports itself on screen; returns the
 * cleanup. A counter, not a boolean, so a remount's effect order (new mount
 * before old cleanup) cannot leave it stuck off.
 */
export function reportWorkPage(): () => void {
  workPageCount += 1;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      workPageCount -= 1;
    }
  };
}

export function workPageOnScreen(): boolean {
  return workPageCount > 0;
}

export function isPhoneViewport(): boolean {
  return globalThis.matchMedia?.(PHONE_TOAST_QUERY).matches ?? false;
}
