# Harness role policy

Buzz and every native harness adapter read one provider-neutral desired-state
file: `~/.config/agent-harness/role-policy.json` (override with
`HARNESS_ROLE_POLICY_FILE`). Buzz owns writes to this file. Saves are atomic,
mode-restricted, and retain the immediately previous version beside it as
`role-policy.json.rollback`. On first read, Buzz migrates the former
app-data `agents/harness-policy.json` store when the shared file is absent.
The Tauri commands are:

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

Profile config paths and formats are serialized explicitly as `null` when
unset, keeping the Rust and TypeScript contracts byte-for-byte aligned. Saves
use the persisted revision as an optimistic concurrency token and reject a
stale edit before the atomic write, so a later policy cannot be overwritten by
an older dialog. Custom catalog ids such as `claude-code-glm` are resolved from
the selected runtime id before the static built-in fallback and receive the
same exact overlay path.

`claude-code-glm` is the runtime-catalog alias for the installable native config
profile `claude-glm`; both entries must select the same adapter. The native
generator installs seven Claude config profiles and resolves this alias to its
target rather than creating an eighth config directory.

The native projection is generated from one policy: Codex uses exact custom
agent model/effort settings; `claude-codex` forces exact Sol subagents; other
Claude Code profiles route named stages through the Codex role runner and
reject native-Agent bypasses. Connector assignments use the same global and
per-agent inheritance model. Shared remote integrations resolve through the
central relay; browser/computer tools remain local edge adapters.

The installed desktop bundle is intentionally not replaced by a development
source change. Validate this surface with the E2E-mode bundle and its mocked
Tauri bridge; install it through the documented full desktop rebuild and
mv-swap procedure only as a separately authorized application release.
