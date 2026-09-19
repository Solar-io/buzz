import { invokeTauri } from "./tauri";
import type {
  CompiledHarnessPolicy,
  CompiledHarnessProfile,
  HarnessPolicy,
  HarnessRuntimeCatalog,
  HarnessPolicySaveResult,
  HarnessPolicyState,
} from "./types";

/** Read the provider-neutral role policy and its canonical hash. */
export function getHarnessPolicy(): Promise<HarnessPolicyState> {
  return invokeTauri<HarnessPolicyState>("get_harness_policy");
}

/** Validate and save desired role policy state. */
export function setHarnessPolicy(
  policy: HarnessPolicy,
): Promise<HarnessPolicySaveResult> {
  return invokeTauri<HarnessPolicySaveResult>("set_harness_policy", {
    policy,
  });
}

/** Compile desired state against an adapter's live capability catalog. */
export function compileHarnessPolicy(
  policy: HarnessPolicy,
  catalog: HarnessRuntimeCatalog,
  agentPubkey?: string,
): Promise<CompiledHarnessPolicy> {
  return invokeTauri<CompiledHarnessPolicy>("compile_harness_policy", {
    policy,
    catalog,
    agentPubkey: agentPubkey ?? null,
  });
}

/** Compile one exact profile overlay for a native spawn adapter. */
export function compileHarnessProfileOverlay(
  policy: HarnessPolicy,
  catalog: HarnessRuntimeCatalog,
  profileId: string,
  agentPubkey?: string,
): Promise<CompiledHarnessProfile> {
  return invokeTauri<CompiledHarnessProfile>(
    "compile_harness_profile_overlay",
    {
      policy,
      catalog,
      profileId,
      agentPubkey: agentPubkey ?? null,
    },
  );
}
