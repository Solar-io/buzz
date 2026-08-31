import { index, route, rootRoute } from "@tanstack/virtual-file-routes";

export const routes = rootRoute("root.tsx", [
  index("index.tsx"),
  route("/repos", "repos.tsx"),
  route("/repos/browse", "repos.browse.tsx"),
  route("/repos/settings", "repos.settings.tsx"),
  route("/repos/agents", "repos.agents.tsx"),
  route("/invite/$code", "invite.$code.tsx"),
  route("/repos/$repoId", "repos.$repoId.tsx"),
  route("/repos/$repoId/blob/$", "repos.$repoId.blob.$.tsx"),
]);
