# Harness role policy

Buzz stores the provider-neutral role policy in the desktop agent data
directory as `harness-policy.json`. The Tauri commands are:

- `get_harness_policy` — returns the desired policy and canonical SHA-256 hash.
- `set_harness_policy` — validates and atomically persists global defaults,
  runtime adapter selections, and per-agent overrides.
- `compile_harness_policy` — compiles desired routes against a live native
  runtime catalog and returns unsupported exact routes without substitution.
- `compile_harness_profile_overlay` — returns one profile's exact overlay for
  a spawn adapter.

The default matrix is `gpt-5.6-sol` with `high` effort for Architect and
`low` effort for Coder, QA/tester variants, Verifier, and generic Worker.
Delegation remains proportional by default; an explicit architect or dev-team
request requires the complete pipeline.

Native runtime adapters own capability facts. A missing exact model or effort
is an unsupported route, not permission to choose a nearby value. Claude
profiles without native exact-Sol enforcement use the explicit
`codex_role_runner` adapter. Desired routes, selected adapter, effective
routes, and health are separate fields in the compiler result.

Managed agent spawns carry the provider-neutral overlay in the reserved
`BUZZ_HARNESS_POLICY_JSON`, `BUZZ_HARNESS_POLICY_HASH`, and
`BUZZ_HARNESS_POLICY_PROFILE` variables. User/persona env values cannot
override these keys.
