import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCommunities } from "@/features/communities/useCommunities";
import { useIdentityQuery } from "@/shared/api/hooks";
import {
  getAgentUsageAnalytics,
  onAgentMetricsChanged,
} from "@/shared/api/tauriArchive";
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
