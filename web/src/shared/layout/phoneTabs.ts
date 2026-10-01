/**
 * Phone navigation policy (web redesign phase-1 §6), pure so the rule that
 * matters — the tab bar hides while a conversation is open — is testable
 * without a DOM.
 *
 * Below `md` the shell has three tabs: Work (the home screen), Channels (the
 * channel list as a page) and More (a sheet of the remaining views). The tab
 * is derived from the URL, never stored: `?view=work` is Work, `?view=channels`
 * (or a bare shell) is Channels, any other view belongs to More. A
 * conversation — or the web layer (Files / a link) — takes the whole screen;
 * the bar hides and the top bar shows a back chevron to the last tab instead.
 */

export type PhoneTab = "work" | "channels" | "more";

export interface PhoneNavInput {
  /** `?c=` resolved to a conversation. */
  conversationOpen: boolean;
  /** `?view=`. */
  view: string | undefined;
  /** Files or a link covers the row. */
  webLayerActive: boolean;
}

/** The bar shows on tab pages only — never over a conversation. */
export function phoneTabBarVisible(input: PhoneNavInput): boolean {
  if (input.webLayerActive) {
    return false;
  }
  return input.view !== undefined || !input.conversationOpen;
}

/**
 * Views that own the whole phone screen: their own header (with a back
 * chevron) and their own bottom bar, so the tab bar steps aside. The
 * Terminal's key bar sits where the tabs would (PhoneTerminal artboard).
 */
export function viewOwnsPhoneScreen(view: string | undefined): boolean {
  return view === "terminal";
}

/** Which tab the current page belongs to. */
export function activePhoneTab(view: string | undefined): PhoneTab {
  if (view === "work") {
    return "work";
  }
  if (view === undefined || view === "channels") {
    return "channels";
  }
  return "more";
}

let lastTab: Exclude<PhoneTab, "more"> = "work";

/** Remember the tab a conversation was opened from (the back chevron's target). */
export function rememberPhoneTab(tab: PhoneTab): void {
  if (tab !== "more") {
    lastTab = tab;
  }
}

/** Where the conversation's back chevron returns. Work until a tab is visited. */
export function lastPhoneTab(): Exclude<PhoneTab, "more"> {
  return lastTab;
}
