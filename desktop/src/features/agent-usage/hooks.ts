import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCommunities } from "@/features/communities/useCommunities";
import { useIdentityQuery } from "@/shared/api/hooks";
import {
  getAgentUsageAnalytics,
  onAgentMetricsChanged,
} from "@/shared/api/tauriArchive";
import {
  confirmUsageAccountAttribution,
  getUsageAttributionOverview,
  type UsageAttributionOverview,
} from "@/shared/api/tauriUsageAttribution";
import { usageWindow, type UsageSearch } from "./lib/analytics";

export function useUsageAnalytics(search: UsageSearch) {
  const client = useQueryClient();
  const identity = useIdentityQuery();
  const { activeCommunity } = useCommunities();
  const [now, setNow] = useState(() => new Date());
  const [firstReportedAt, setFirstReportedAt] = useState<number | null>(null);
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(
    () =>
      onAgentMetricsChanged(() => {
        void client.invalidateQueries({ queryKey: ["agent-usage-analytics"] });
      }),
    [client],
  );
  const window = usageWindow(search, now, firstReportedAt);
  const request = window.request;
  const query = useQuery({
    queryKey: [
      "agent-usage-analytics",
      identity.data?.pubkey,
      activeCommunity?.relayUrl,
      request,
    ],
    queryFn: () => {
      if (!request) throw new Error("Invalid date range");
      return getAgentUsageAnalytics(request);
    },
    enabled: Boolean(request && identity.data?.pubkey),
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: 1,
  });
  useEffect(() => {
    if (query.data)
      setFirstReportedAt(query.data.coverage.archiveFirstReportedAt ?? null);
  }, [query.data]);
  return {
    query,
    window,
    scopeKey: `${identity.data?.pubkey ?? ""}:${activeCommunity?.relayUrl ?? ""}`,
  };
}

/**
 * The owner-editable account attribution mapping.
 *
 * `save` resolves `true` when the edit landed. A confirmed edit changes what
 * the next spawn publishes, so the analytics query is invalidated too — the
 * archived reports it reads are unchanged until agents restart, which is the
 * honest behaviour, but the coverage note below the dashboard reflects the new
 * mapping immediately.
 */
export function useUsageAttribution() {
  const client = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["usage-attribution-overview"],
    queryFn: getUsageAttributionOverview,
    staleTime: 60_000,
  });
  async function save(input: {
    accountId: string;
    newAccountId: string;
    accountLabel: string;
    provider: string;
  }): Promise<boolean> {
    setSaving(true);
    setError(null);
    try {
      const next: UsageAttributionOverview =
        await confirmUsageAccountAttribution(input);
      client.setQueryData(["usage-attribution-overview"], next);
      void client.invalidateQueries({ queryKey: ["agent-usage-analytics"] });
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setSaving(false);
    }
  }
  return { query, save, saving, error };
}
