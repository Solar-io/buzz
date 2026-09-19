import { AlertCircle, Check, Loader, RotateCcw } from "lucide-react";
import * as React from "react";

import {
  getHarnessPolicy,
  setHarnessPolicy,
} from "@/shared/api/tauriHarnessPolicy";
import type {
  HarnessEffort,
  HarnessPolicy,
  HarnessPolicyAdapter,
  HarnessRole,
  HarnessRoleRoute,
  HarnessPolicyState,
} from "@/shared/api/types";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";

const ROLE_ROWS: ReadonlyArray<{ key: HarnessRole; label: string }> = [
  { key: "architect", label: "Architect" },
  { key: "coder", label: "Coder" },
  { key: "qa", label: "QA" },
  { key: "tester", label: "Tester" },
  { key: "backend_tester", label: "Backend tester" },
  { key: "ui_tester", label: "UI tester" },
  { key: "verifier", label: "Verifier" },
  { key: "worker", label: "Generic worker" },
];

const EFFORT_OPTIONS: ReadonlyArray<{ value: HarnessEffort; label: string }> = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "x_high", label: "X-high" },
  { value: "max", label: "Max" },
];

const ADAPTER_OPTIONS: ReadonlyArray<{
  value: HarnessPolicyAdapter;
  label: string;
}> = [
  { value: "native", label: "Native runtime" },
  { value: "codex_role_runner", label: "Codex role-runner adapter" },
];

const FIELD_CLASS =
  "h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring";

type PolicyEditorProps = {
  /** `undefined` edits the global role defaults; a pubkey edits overrides. */
  agentPubkey?: string;
  compact?: boolean;
  disabled?: boolean;
};

type SaveState = "idle" | "saving" | "saved" | "error";

function routeFor(
  policy: HarnessPolicy,
  role: HarnessRole,
  agentPubkey?: string,
): {
  route: HarnessRoleRoute | undefined;
  override: HarnessRoleRoute | undefined;
} {
  const override = agentPubkey
    ? policy.agentOverrides[agentPubkey]?.[role]
    : undefined;
  return {
    override,
    route: override ?? policy.roleDefaults[role],
  };
}

function updateRole(
  policy: HarnessPolicy,
  role: HarnessRole,
  next: HarnessRoleRoute,
  agentPubkey?: string,
): HarnessPolicy {
  if (!agentPubkey) {
    return {
      ...policy,
      roleDefaults: { ...policy.roleDefaults, [role]: next },
    };
  }
  return {
    ...policy,
    agentOverrides: {
      ...policy.agentOverrides,
      [agentPubkey]: {
        ...(policy.agentOverrides[agentPubkey] ?? {}),
        [role]: next,
      },
    },
  };
}

function clearOverride(
  policy: HarnessPolicy,
  role: HarnessRole,
  agentPubkey: string,
): HarnessPolicy {
  const current = policy.agentOverrides[agentPubkey] ?? {};
  const { [role]: _removed, ...remaining } = current;
  const agentOverrides = { ...policy.agentOverrides };
  if (Object.keys(remaining).length === 0) {
    delete agentOverrides[agentPubkey];
  } else {
    agentOverrides[agentPubkey] = remaining;
  }
  return { ...policy, agentOverrides };
}

/**
 * Global role defaults and per-agent overrides share one editor so the two
 * surfaces cannot drift in field names or exact-route semantics.
 */
export function HarnessPolicyEditor({
  agentPubkey,
  compact = false,
  disabled = false,
}: PolicyEditorProps) {
  const [state, setState] = React.useState<HarnessPolicyState | null>(null);
  const [draft, setDraft] = React.useState<HarnessPolicy | null>(null);
  const [dirty, setDirty] = React.useState(false);
  const [saveState, setSaveState] = React.useState<SaveState>("idle");
  const [error, setError] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState(!compact);

  // The policy document is shared, but changing between global and one-agent
  // scopes must reset the local draft and loading state.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scope change intentionally resets the editor
  React.useEffect(() => {
    let cancelled = false;
    setState(null);
    setDraft(null);
    setDirty(false);
    setSaveState("idle");
    setError(null);
    setExpanded(!compact);
    getHarnessPolicy()
      .then((loaded) => {
        if (cancelled) return;
        setState(loaded);
        setDraft(loaded.policy);
      })
      .catch((reason) => {
        if (cancelled) return;
        setError(
          typeof reason === "string" ? reason : "Couldn't load harness policy.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [agentPubkey]);

  const updateDraft = React.useCallback((next: HarnessPolicy) => {
    setDraft(next);
    setDirty(true);
    setSaveState("idle");
    setError(null);
  }, []);

  async function save() {
    if (!draft) return;
    setSaveState("saving");
    setError(null);
    try {
      const result = await setHarnessPolicy(draft);
      setState(result.state);
      setDraft(result.state.policy);
      setDirty(false);
      setSaveState("saved");
    } catch (reason) {
      setSaveState("error");
      setError(
        typeof reason === "string" ? reason : "Couldn't save harness policy.",
      );
    }
  }

  if (error && !draft) {
    return (
      <div
        className="flex items-center gap-2 text-sm text-destructive"
        data-testid="harness-policy-error"
      >
        <AlertCircle className="size-4" />
        <span>{error}</span>
      </div>
    );
  }
  if (!draft || !state) {
    return (
      <div
        className="flex items-center gap-2 py-2 text-sm text-muted-foreground"
        data-testid="harness-policy-loading"
      >
        <Loader className="size-4 animate-spin" />
        Loading role policy…
      </div>
    );
  }

  return (
    <section
      aria-label={agentPubkey ? "Agent role overrides" : "Global role defaults"}
      className={cn(
        "space-y-4",
        compact ? "pt-2" : "border-t border-border/60 pt-5",
      )}
      data-testid={
        agentPubkey ? "agent-harness-policy-overrides" : "global-harness-policy"
      }
    >
      <button
        aria-expanded={expanded}
        className="flex w-full items-center justify-between text-left"
        data-testid="harness-policy-toggle"
        onClick={() => setExpanded((current) => !current)}
        type="button"
      >
        <span className="text-sm font-semibold text-foreground">
          {agentPubkey ? "Role overrides" : "Role routing"}
        </span>
        <span className="text-xs text-muted-foreground">
          {expanded ? "Hide" : "Configure"}
        </span>
      </button>

      {expanded ? (
        <>
          <p className="text-xs text-muted-foreground">
            {agentPubkey
              ? "Choose exact model and effort values for this agent. Unchanged roles inherit global defaults."
              : "Set exact model and effort defaults. Native adapters refuse routes their live catalog cannot enforce. An explicit architect or dev-team request uses the full pipeline."}
          </p>

          <div className="space-y-2" data-testid="harness-policy-role-rows">
            {ROLE_ROWS.map(({ key, label }) => {
              const { route, override } = routeFor(draft, key, agentPubkey);
              const effectiveRoute = route ?? {
                model: "",
                effort: "low" as const,
              };
              return (
                <div
                  className="grid grid-cols-[minmax(7rem,0.8fr)_minmax(9rem,1.5fr)_6.5rem_auto] items-center gap-2"
                  data-testid={`harness-policy-role-${key}`}
                  key={key}
                >
                  <label
                    className="text-sm text-foreground"
                    htmlFor={`harness-policy-model-${key}`}
                  >
                    {label}
                  </label>
                  <Input
                    aria-label={`${label} model`}
                    className="h-9"
                    data-testid={`harness-policy-model-${key}`}
                    disabled={disabled}
                    id={`harness-policy-model-${key}`}
                    onChange={(event) =>
                      updateDraft(
                        updateRole(
                          draft,
                          key,
                          { ...effectiveRoute, model: event.target.value },
                          agentPubkey,
                        ),
                      )
                    }
                    value={effectiveRoute.model}
                  />
                  <select
                    aria-label={`${label} effort`}
                    className={FIELD_CLASS}
                    data-testid={`harness-policy-effort-${key}`}
                    disabled={disabled}
                    onChange={(event) => {
                      if (agentPubkey && event.target.value === "inherit") {
                        updateDraft(clearOverride(draft, key, agentPubkey));
                        return;
                      }
                      updateDraft(
                        updateRole(
                          draft,
                          key,
                          {
                            ...effectiveRoute,
                            effort: event.target.value as HarnessEffort,
                          },
                          agentPubkey,
                        ),
                      );
                    }}
                    value={
                      agentPubkey && !override
                        ? "inherit"
                        : effectiveRoute.effort
                    }
                  >
                    {agentPubkey ? (
                      <option value="inherit">Inherit</option>
                    ) : null}
                    {EFFORT_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  {agentPubkey && override ? (
                    <Button
                      aria-label={`Reset ${label} override`}
                      data-testid={`harness-policy-reset-${key}`}
                      disabled={disabled}
                      onClick={() =>
                        updateDraft(clearOverride(draft, key, agentPubkey))
                      }
                      size="icon"
                      variant="ghost"
                    >
                      <RotateCcw className="size-3.5" />
                    </Button>
                  ) : (
                    <span className="w-9" />
                  )}
                </div>
              );
            })}
          </div>

          {!agentPubkey ? (
            <div
              className="space-y-2"
              data-testid="harness-policy-profile-rows"
            >
              <p className="text-xs font-medium text-muted-foreground">
                Runtime adapters
              </p>
              {Object.entries(draft.profiles).map(([profileId, profile]) => (
                <div
                  className="grid grid-cols-[minmax(8rem,1fr)_minmax(12rem,1.2fr)] items-center gap-2"
                  key={profileId}
                >
                  <span className="text-sm text-foreground">{profileId}</span>
                  <select
                    aria-label={`${profileId} adapter`}
                    className={FIELD_CLASS}
                    data-testid={`harness-policy-adapter-${profileId}`}
                    disabled={disabled}
                    onChange={(event) =>
                      updateDraft({
                        ...draft,
                        profiles: {
                          ...draft.profiles,
                          [profileId]: {
                            ...profile,
                            adapter: event.target.value as HarnessPolicyAdapter,
                          },
                        },
                      })
                    }
                    value={profile.adapter}
                  >
                    {ADAPTER_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          ) : null}

          <div className="flex items-center gap-2">
            {saveState === "saved" ? (
              <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                <Check className="size-3.5" /> Saved
              </span>
            ) : null}
            {saveState === "error" && error ? (
              <span className="text-xs text-destructive">{error}</span>
            ) : null}
            <span
              className="ml-auto text-xs text-muted-foreground"
              data-testid="harness-policy-hash"
            >
              Policy {state.policyHash.slice(0, 12)}
            </span>
            <Button
              data-testid="harness-policy-save"
              disabled={!dirty || disabled || saveState === "saving"}
              onClick={() => void save()}
              size="sm"
            >
              {saveState === "saving" ? (
                <Loader className="mr-1.5 size-3.5 animate-spin" />
              ) : null}
              Save policy
            </Button>
          </div>
        </>
      ) : null}
    </section>
  );
}

export const __harnessPolicyTestExports = {
  clearOverride,
  routeFor,
  updateRole,
};
