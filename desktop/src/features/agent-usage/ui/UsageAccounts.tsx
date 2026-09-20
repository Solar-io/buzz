import { useState } from "react";
import { Check, Pencil } from "lucide-react";
import type { AgentUsageAnalytics } from "@/shared/api/tauriArchive";
import type { UsageAttributionAccountRow } from "@/shared/api/tauriUsageAttribution";
import { useUsageAttribution } from "../hooks";
import { SEEDED_MARKER, provisionalAccountCount } from "../lib/accounts";
import { UsageCard } from "./UsageCharts";

/**
 * Coverage note for the account dimension, in the same voice as the service
 * tier and reporting-coverage notes: a count out of the total, and what the
 * missing part actually means.
 */
export function AccountCoverageNote({ data }: { data: AgentUsageAnalytics }) {
  const provisional = provisionalAccountCount(data.accounts);
  return (
    <p className="usage-note">
      Account identity confirmed for{" "}
      {data.coverage.confirmedAccountReports.toLocaleString()} of{" "}
      {data.coverage.accountReports.toLocaleString()} attributed turns
      {data.summary.reportCount > data.coverage.accountReports
        ? `; ${(
            data.summary.reportCount - data.coverage.accountReports
          ).toLocaleString()} turns reported no account at all`
        : ""}
      .{" "}
      {provisional > 0
        ? `${provisional.toLocaleString()} account${provisional === 1 ? "" : "s"} below ${
            provisional === 1 ? "is" : "are"
          } marked “${SEEDED_MARKER}”: Buzz grouped ${
            provisional === 1 ? "it" : "them"
          } from recorded configuration, which is not a subscription identity until you confirm it.`
        : "Confirmed labels are yours; seeded ones are grouped from recorded configuration only."}
    </p>
  );
}

function AccountForm({
  account,
  busy,
  onSave,
  onCancel,
}: {
  account: UsageAttributionAccountRow;
  busy: boolean;
  onSave: (input: {
    newAccountId: string;
    accountLabel: string;
    provider: string;
  }) => void;
  onCancel: () => void;
}) {
  const [accountId, setAccountId] = useState(account.accountId);
  const [label, setLabel] = useState(account.accountLabel ?? "");
  const [provider, setProvider] = useState(account.provider ?? "");
  return (
    <form
      className="usage-attribution-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({
          newAccountId: accountId,
          accountLabel: label,
          provider,
        });
      }}
    >
      <label>
        Subscription name
        <input
          value={label}
          disabled={busy}
          placeholder="Claude Max"
          onChange={(event) => setLabel(event.target.value)}
        />
      </label>
      <label>
        Account ID
        <input
          value={accountId}
          disabled={busy}
          placeholder="claude-max-cc1"
          onChange={(event) => setAccountId(event.target.value)}
        />
      </label>
      <label>
        Provider
        <input
          value={provider}
          disabled={busy}
          placeholder="anthropic"
          onChange={(event) => setProvider(event.target.value)}
        />
      </label>
      <div className="usage-attribution-actions">
        <button type="submit" className="usage-button" disabled={busy}>
          <Check size={13} />
          Confirm
        </button>
        <button
          type="button"
          className="usage-button"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className="usage-button"
          disabled={busy}
          onClick={() =>
            onSave({ newAccountId: "", accountLabel: "", provider: "" })
          }
        >
          Not a subscription
        </button>
      </div>
    </form>
  );
}

function AgentNames({ agents }: { agents: { name: string }[] }) {
  return (
    <span>
      {agents.length.toLocaleString()} agent{agents.length === 1 ? "" : "s"}
      {agents.length > 0
        ? ` · ${agents
            .slice(0, 4)
            .map((agent) => agent.name)
            .join(
              ", ",
            )}${agents.length > 4 ? `, +${agents.length - 4} more` : ""}`
        : ""}
    </span>
  );
}

/**
 * The owner's edit surface for subscription identity.
 *
 * Editing is confirming: there is no separate "mark confirmed" control, so an
 * owner value can never be saved while still reading as something Buzz
 * guessed. Clearing every field is also an answer — "this is not a
 * subscription" — and it survives the next launch's seeding pass.
 */
export function AccountAttribution() {
  const { query, save, saving, error } = useUsageAttribution();
  const [editing, setEditing] = useState<string | null>(null);
  const overview = query.data;
  return (
    <UsageCard
      title="Accounts & subscriptions"
      subtitle="Seeded labels are grouped from recorded configuration, not confirmed"
    >
      {query.isPending && (
        <p className="usage-empty" role="status">
          Loading account attribution…
        </p>
      )}
      {query.isError && (
        <p className="usage-empty" role="alert">
          Account attribution could not be loaded.
        </p>
      )}
      {error && (
        <p className="usage-empty" role="alert">
          {error}
        </p>
      )}
      {overview && (
        <ul className="usage-attribution-list">
          {overview.accounts.map((account) => (
            <li key={account.accountId} data-confirmed={account.confirmed}>
              <div className="usage-attribution-row">
                <div>
                  <strong>{account.accountLabel ?? account.accountId}</strong>
                  <span>
                    {account.confirmed ? "Confirmed" : SEEDED_MARKER}
                    {account.provider ? ` · provider ${account.provider}` : ""}
                  </span>
                  <AgentNames agents={account.agents} />
                </div>
                {editing !== account.accountId && (
                  <button
                    type="button"
                    className="usage-button"
                    onClick={() => setEditing(account.accountId)}
                  >
                    <Pencil size={13} />
                    {account.confirmed ? "Edit" : "Confirm"}
                  </button>
                )}
              </div>
              {editing === account.accountId && (
                <AccountForm
                  account={account}
                  busy={saving}
                  onCancel={() => setEditing(null)}
                  onSave={(input) => {
                    void save({
                      accountId: account.accountId,
                      ...input,
                    }).then((ok) => ok && setEditing(null));
                  }}
                />
              )}
            </li>
          ))}
          {overview.accounts.length === 0 && (
            <li>
              <p className="usage-empty">
                No accounts yet. Attribution is seeded from recorded agent
                configuration on launch.
              </p>
            </li>
          )}
        </ul>
      )}
      {overview && overview.unattributed.length > 0 && (
        <p className="usage-note">
          {overview.unattributed.length.toLocaleString()} agent
          {overview.unattributed.length === 1 ? "" : "s"} have no recorded
          harness, provider or gateway, so nothing was seeded and their usage is
          not grouped under any account:{" "}
          {overview.unattributed
            .slice(0, 6)
            .map((agent) => agent.name)
            .join(", ")}
          {overview.unattributed.length > 6
            ? `, +${overview.unattributed.length - 6} more`
            : ""}
          .
        </p>
      )}
      {overview && overview.declined.length > 0 && (
        <p className="usage-note">
          {overview.declined.length.toLocaleString()} agent
          {overview.declined.length === 1 ? "" : "s"} you marked as not a
          subscription:{" "}
          {overview.declined.map((agent) => agent.name).join(", ")}.
        </p>
      )}
    </UsageCard>
  );
}
