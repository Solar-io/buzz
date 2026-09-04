/**
 * React bindings over the template store, plus the roster catalog the editor
 * and the applier both read.
 *
 * The catalog is the owner's live 30175 personas and 30176 teams — the same
 * two subscriptions the agents page already runs, reused rather than
 * duplicated so a template can only ever name a persona this client can see.
 */

import { useCallback, useMemo, useSyncExternalStore } from "react";

import { usePersonas } from "@/features/agents/usePersonas";
import { useTeams } from "@/features/agents/useTeams";

import type { RosterPersona, RosterTeam } from "./lib/applyTemplate.ts";
import type {
  ChannelTemplate,
  ChannelTemplateDraft,
} from "./lib/templateModel.ts";
import { mergeImported } from "./lib/templateModel.ts";
import {
  browserOpDeps,
  createTemplate,
  deleteTemplate,
  duplicateTemplate,
  updateTemplate,
} from "./lib/templateOps.ts";
import {
  subscribeTemplates,
  templatesLoaded,
  templatesSnapshot,
  writeTemplates,
} from "./templateStore.ts";

export interface ChannelTemplatesApi {
  templates: ChannelTemplate[];
  loaded: boolean;
  create: (draft: ChannelTemplateDraft) => Promise<string | null>;
  update: (id: string, draft: ChannelTemplateDraft) => Promise<string | null>;
  duplicate: (id: string) => Promise<string | null>;
  remove: (id: string) => Promise<string | null>;
  importTemplates: (imported: ChannelTemplate[]) => Promise<number>;
}

/**
 * Every mutator returns an error string or null, matching the pure ops it
 * wraps, so the card can toast without a try/catch at each call site.
 */
export function useChannelTemplates(): ChannelTemplatesApi {
  const templates = useSyncExternalStore(
    subscribeTemplates,
    templatesSnapshot,
    templatesSnapshot,
  );
  const loaded = useSyncExternalStore(
    subscribeTemplates,
    templatesLoaded,
    templatesLoaded,
  );

  /**
   * Every mutator funnels its write through here so a storage failure becomes
   * a returned error string instead of an unhandled rejection.
   *
   * That distinction is the whole point: `writeTemplates` updates the
   * in-memory mirror and emits BEFORE it awaits IndexedDB, so on a failed
   * write the template appears in the list, the dialog closes, and it is gone
   * on the next reload — a silent data loss that looks exactly like success.
   * Returning the message lets the caller say so.
   */
  const persist = useCallback(async (next: ChannelTemplate[]) => {
    try {
      await writeTemplates(next);
      return null;
    } catch (error) {
      return error instanceof Error
        ? error.message
        : "Could not save templates.";
    }
  }, []);

  const create = useCallback(
    async (draft: ChannelTemplateDraft) => {
      const result = createTemplate(
        templatesSnapshot(),
        draft,
        browserOpDeps(),
      );
      if ("error" in result) return result.error;
      return persist(result.templates);
    },
    [persist],
  );

  const update = useCallback(
    async (id: string, draft: ChannelTemplateDraft) => {
      const result = updateTemplate(
        templatesSnapshot(),
        id,
        draft,
        browserOpDeps(),
      );
      if ("error" in result) return result.error;
      return persist(result.templates);
    },
    [persist],
  );

  const duplicate = useCallback(
    async (id: string) => {
      const result = duplicateTemplate(
        templatesSnapshot(),
        id,
        browserOpDeps(),
      );
      if ("error" in result) return result.error;
      return persist(result.templates);
    },
    [persist],
  );

  const remove = useCallback(
    async (id: string) => {
      const result = deleteTemplate(templatesSnapshot(), id);
      if ("error" in result) return result.error;
      return persist(result.templates);
    },
    [persist],
  );

  const importTemplates = useCallback(
    async (imported: ChannelTemplate[]) => {
      const merged = mergeImported(templatesSnapshot(), imported);
      const issue = await persist(merged);
      if (issue) throw new Error(issue);
      return imported.length;
    },
    [persist],
  );

  return {
    templates,
    loaded,
    create,
    update,
    duplicate,
    remove,
    importTemplates,
  };
}

export interface RosterCatalog {
  personas: RosterPersona[];
  teams: RosterTeam[];
}

/** The owner's personas and teams, flattened into the applier's shapes. */
export function useRosterCatalog(): RosterCatalog {
  const personas = usePersonas();
  const teams = useTeams();

  return useMemo(() => {
    const personaRows: RosterPersona[] = [...personas.values()]
      .map((persona) => ({
        id: persona.id,
        name: persona.name,
        systemPrompt: persona.systemPrompt,
        model: persona.model,
        provider: persona.provider,
        runtime: persona.runtime,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
    const teamRows: RosterTeam[] = [...teams.values()]
      .map((team) => ({ id: team.id, personaIds: team.personaIds }))
      .sort((left, right) => left.id.localeCompare(right.id));
    return { personas: personaRows, teams: teamRows };
  }, [personas, teams]);
}

/** Display names for teams, keyed by id — the catalog drops them. */
export function useTeamNames(): Map<string, string> {
  const teams = useTeams();
  return useMemo(
    () => new Map([...teams.values()].map((team) => [team.id, team.name])),
    [teams],
  );
}
