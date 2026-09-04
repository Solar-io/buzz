/**
 * Pure create / update / duplicate / delete transitions over a template list.
 *
 * These mirror `desktop/src-tauri/src/commands/channel_templates.rs` one
 * command at a time. They live apart from the IndexedDB store so the rules
 * that actually decide the outcome — trimming, validation, the built-in
 * deletion guard, the "(Copy)" naming — can be exercised without a browser.
 *
 * Every operation returns either `{ templates, template }` or `{ error }`;
 * nothing throws, so a caller can toast the message.
 */

import {
  type ChannelTemplate,
  type ChannelTemplateDraft,
  deletionIssue,
  draftIssue,
  sortTemplates,
} from "./templateModel.ts";

export type TemplateOpResult =
  | { templates: ChannelTemplate[]; template: ChannelTemplate }
  | { error: string };

export interface OpDeps {
  /** Injected so tests get deterministic ids and timestamps. */
  newId: () => string;
  now: () => string;
}

export function browserOpDeps(): OpDeps {
  return {
    newId: () =>
      globalThis.crypto?.randomUUID?.() ??
      `tpl-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`,
    now: () => new Date().toISOString(),
  };
}

function normalizeDraft(draft: ChannelTemplateDraft) {
  const description = draft.description.trim();
  const canvasTemplate = draft.canvasTemplate.trim();
  return {
    name: draft.name.trim(),
    description: description.length > 0 ? description : null,
    channelType: draft.channelType,
    visibility: draft.visibility,
    canvasTemplate: canvasTemplate.length > 0 ? canvasTemplate : null,
    agents: {
      personas: draft.agents.personas.map((entry) => ({ ...entry })),
      teams: draft.agents.teams.map((entry) => ({ ...entry })),
    },
  };
}

export function createTemplate(
  templates: ChannelTemplate[],
  draft: ChannelTemplateDraft,
  deps: OpDeps,
): TemplateOpResult {
  const issue = draftIssue(draft);
  if (issue) return { error: issue };
  const now = deps.now();
  const template: ChannelTemplate = {
    id: deps.newId(),
    ...normalizeDraft(draft),
    isBuiltin: false,
    createdAt: now,
    updatedAt: now,
  };
  return { templates: sortTemplates([...templates, template]), template };
}

export function updateTemplate(
  templates: ChannelTemplate[],
  id: string,
  draft: ChannelTemplateDraft,
  deps: OpDeps,
): TemplateOpResult {
  const issue = draftIssue(draft);
  if (issue) return { error: issue };
  const current = templates.find((entry) => entry.id === id);
  if (!current) return { error: `template ${id} not found` };
  const template: ChannelTemplate = {
    ...current,
    ...normalizeDraft(draft),
    updatedAt: deps.now(),
  };
  return {
    templates: sortTemplates(
      templates.map((entry) => (entry.id === id ? template : entry)),
    ),
    template,
  };
}

/**
 * Duplicating a built-in yields an editable copy — `is_builtin: false` on the
 * duplicate is what makes the built-in row useful rather than merely locked.
 */
export function duplicateTemplate(
  templates: ChannelTemplate[],
  id: string,
  deps: OpDeps,
): TemplateOpResult {
  const source = templates.find((entry) => entry.id === id);
  if (!source) return { error: `template ${id} not found` };
  const now = deps.now();
  const template: ChannelTemplate = {
    ...source,
    id: deps.newId(),
    name: `${source.name} (Copy)`,
    isBuiltin: false,
    createdAt: now,
    updatedAt: now,
  };
  return { templates: sortTemplates([...templates, template]), template };
}

export function deleteTemplate(
  templates: ChannelTemplate[],
  id: string,
): { templates: ChannelTemplate[] } | { error: string } {
  const target = templates.find((entry) => entry.id === id);
  if (!target) return { error: `template ${id} not found` };
  const issue = deletionIssue(target);
  if (issue) return { error: issue };
  return { templates: templates.filter((entry) => entry.id !== id) };
}
