import type { AgentSettingField } from "./agentSettingsFields";
import type { SettingValue } from "../../lib/settingsDraft";

/** Shared form surface; values and edits belong to the screen's W7 draft. */
export interface CardFields {
  value: (field: AgentSettingField) => SettingValue;
  edit: (field: AgentSettingField, value: SettingValue) => void;
  dirty: (field: AgentSettingField) => boolean;
  originalLabel?: (field: AgentSettingField) => string | undefined;
  disabled: boolean;
  controlsLocked: boolean;
  machine: string;
}
