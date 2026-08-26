import { toast } from "sonner";

import {
  MAX_PANEL_INSTANCES,
  openWebPanelInstance,
  toggleWebPanel,
} from "./webPanelStore";

function notifyCap() {
  toast.error("Web panel limit reached", {
    description: `Close a tab first — at most ${MAX_PANEL_INSTANCES} panel tabs can stay open at once.`,
  });
}

/** Picker/header entry point: opens a new tab, or explains the cap. */
export function openWebPanelInstanceWithFeedback(panelId: string) {
  const result = openWebPanelInstance(panelId);
  if (!result.ok && result.reason === "cap") notifyCap();
}

/** Header toggle entry point with the same cap feedback. */
export function toggleWebPanelWithFeedback(panelId: string) {
  const result = toggleWebPanel(panelId);
  if (result && !result.ok && result.reason === "cap") notifyCap();
}
