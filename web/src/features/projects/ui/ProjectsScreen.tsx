/**
 * The projects surface as one component: list, detail, and the viewer identity
 * both need.
 *
 * Selection lives here rather than in the router so the feature can be mounted
 * anywhere — a route, a panel, a probe — without the route file owning project
 * state. The orchestrator only has to render `<ProjectsScreen />`.
 */

import { useEffect, useState } from "react";

import { useAuth } from "@/features/auth/ui/AuthProvider";
import { ownPubkey } from "@/shared/lib/nostr-signer";
import type { Project } from "../lib/projectModels.ts";
import { ProjectDetailPage } from "./ProjectDetailPage.tsx";
import { ProjectsPage } from "./ProjectsPage.tsx";
import { useProjectCollection } from "../hooks.ts";

export function ProjectsScreen() {
  const [viewerPubkey, setViewerPubkey] = useState<string | null>(null);
  const [openProjectId, setOpenProjectId] = useState<string | null>(null);
  const { canSign, ready, state } = useAuth();
  const { data } = useProjectCollection();

  // One value standing for "who could be signing right now". `initKeyStore`
  // restores a remembered key asynchronously, so resolving the viewer once on
  // mount races it and answers null — which silently disabled every write
  // control on a page that was, in fact, signed in. Keying the effect on this
  // string re-resolves the moment the key store settles.
  const identity = ready ? `${state.status}:${canSign}` : null;

  useEffect(() => {
    if (!identity) return;
    let cancelled = false;
    void ownPubkey().then((pubkey) => {
      if (!cancelled) setViewerPubkey(pubkey ? pubkey.toLowerCase() : null);
    });
    return () => {
      cancelled = true;
    };
  }, [identity]);

  // Resolve against the live collection rather than holding the object: a
  // replaceable head can be superseded while the detail view is open, and the
  // stale copy would keep rendering the old members.
  const openProject =
    data?.projects.find((project) => project.id === openProjectId) ?? null;

  if (openProjectId && openProject) {
    return (
      <ProjectDetailPage
        onBack={() => setOpenProjectId(null)}
        project={openProject}
        viewerPubkey={viewerPubkey}
      />
    );
  }

  return (
    <ProjectsPage
      onOpenProject={(project: Project) => setOpenProjectId(project.id)}
      ownerPubkey={viewerPubkey}
    />
  );
}
