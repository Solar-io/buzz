import * as React from "react";

import { useManagedAgentsQuery } from "@/features/agents/hooks";
import { useUsersBatchQuery } from "@/features/profile/hooks";
import { normalizePubkey } from "@/shared/lib/pubkey";
import type { Project } from "./projectModels";

/** Load owner profiles and local managed-agent capability for project deletion. */
export function useProjectDeletionAccess(projects: Project[]) {
  const ownerPubkeys = React.useMemo(
    () => [...new Set(projects.map((project) => project.owner))],
    [projects],
  );
  const ownerProfilesQuery = useUsersBatchQuery(ownerPubkeys, {
    enabled: ownerPubkeys.length > 0,
  });
  const managedAgentsQuery = useManagedAgentsQuery();
  const managedAgentPubkeys = React.useMemo(
    () =>
      new Set(
        (managedAgentsQuery.data ?? []).map((agent) =>
          normalizePubkey(agent.pubkey),
        ),
      ),
    [managedAgentsQuery.data],
  );

  return {
    managedAgentPubkeys,
    ownerProfiles: ownerProfilesQuery.data?.profiles,
  };
}
