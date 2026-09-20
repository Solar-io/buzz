import { invokeTauri } from "@/shared/api/tauri";

/** One agent (instance or definition) filed under an account. */
export type UsageAttributionAgentRow = {
  /** `null` for a definition that has not been deployed. */
  pubkey: string | null;
  /** `null` for an agent created without a definition. */
  slug: string | null;
  name: string;
  /**
   * The runtime profile identifier that was observed. A profile id, **not** a
   * capability or provider claim — never render it as a provider.
   */
  runtime: string | null;
};

/** One account/subscription and every agent reporting under it. */
export type UsageAttributionAccountRow = {
  accountId: string;
  provider: string | null;
  accountLabel: string | null;
  /**
   * `true` only when every agent in the group is confirmed. One still-seeded
   * member keeps the whole account provisional.
   */
  confirmed: boolean;
  agents: UsageAttributionAgentRow[];
};

export type UsageAttributionOverview = {
  accounts: UsageAttributionAccountRow[];
  /**
   * Nothing observable was recorded for these agents, so nothing was seeded.
   * Not a placeholder account, and never counted as zero.
   */
  unattributed: UsageAttributionAgentRow[];
  /**
   * The owner explicitly recorded that these agents have no subscription
   * identity. Distinct from `unattributed`: this is an answer.
   */
  declined: UsageAttributionAgentRow[];
};

export async function getUsageAttributionOverview(): Promise<UsageAttributionOverview> {
  return invokeTauri<UsageAttributionOverview>(
    "get_usage_attribution_overview",
  );
}

/**
 * Confirm (or rename, or clear) one account across every agent filed under it.
 *
 * `accountId` selects the group as it stands today. Editing *is* confirming —
 * there is no separate flag to set, so an owner value can never be left
 * looking like something Buzz seeded.
 */
export async function confirmUsageAccountAttribution(input: {
  accountId: string;
  provider?: string | null;
  newAccountId?: string | null;
  accountLabel?: string | null;
}): Promise<UsageAttributionOverview> {
  return invokeTauri<UsageAttributionOverview>(
    "confirm_usage_account_attribution",
    {
      accountId: input.accountId,
      provider: input.provider ?? null,
      newAccountId: input.newAccountId ?? null,
      accountLabel: input.accountLabel ?? null,
    },
  );
}

/**
 * Move one agent to a different account, or clear its attribution. Pass the
 * agent's pubkey, or a definition's slug.
 */
export async function setAgentUsageAttribution(input: {
  pubkey: string;
  provider?: string | null;
  accountId?: string | null;
  accountLabel?: string | null;
}): Promise<UsageAttributionOverview> {
  return invokeTauri<UsageAttributionOverview>("set_agent_usage_attribution", {
    pubkey: input.pubkey,
    provider: input.provider ?? null,
    accountId: input.accountId ?? null,
    accountLabel: input.accountLabel ?? null,
  });
}
