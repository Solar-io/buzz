import { lazy, Suspense } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { validateUsageSearch } from "@/features/agent-usage/lib/analytics";
const UsagePage = lazy(async () => ({
  default: (await import("@/features/agent-usage/ui/AgentUsagePage"))
    .AgentUsagePage,
}));
export const Route = createFileRoute("/agents/usage")({
  validateSearch: validateUsageSearch,
  component: () => (
    <Suspense fallback={<div role="status">Loading usage…</div>}>
      <UsagePage />
    </Suspense>
  ),
});
