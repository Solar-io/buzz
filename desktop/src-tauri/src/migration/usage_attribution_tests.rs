//! Boot-seeding tests over a store shaped like the real one.
//!
//! The fixture mirrors the distribution actually on disk: many agents on one
//! custom harness, a handful on a builtin, one behind its own gateway, and
//! several with no recorded runtime at all. The last group is the proof case —
//! it must come out of seeding with no attribution whatsoever.
//!
//! Two layers are covered, deliberately. The [`seed_records`] tests pin the
//! per-record *decision*. The [`on_disk`] tests pin the *file and directory*
//! layer that actually runs at boot — which store gets opened, that the bytes
//! land in the file the app later reads, and that a second launch rewrites
//! nothing. A green decision layer says nothing about either, so both are
//! required; see [`super::materialize`]'s tests for the same split.

use super::*;

fn definition(slug: &str, runtime: Option<&str>, provider: Option<&str>, env: Value) -> Value {
    serde_json::json!({
        "pubkey": "",
        "slug": slug,
        "name": slug,
        "runtime": runtime,
        "provider": provider,
        "env_vars": env,
    })
}

fn instance(
    pubkey: &str,
    persona_id: Option<&str>,
    runtime: Option<&str>,
    provider: Option<&str>,
    env: Value,
) -> Value {
    serde_json::json!({
        "pubkey": pubkey,
        "name": pubkey,
        "persona_id": persona_id,
        "runtime": runtime,
        "provider": provider,
        "env_vars": env,
    })
}

fn attribution(record: &Value) -> Option<&serde_json::Map<String, Value>> {
    record.get("usage_attribution").and_then(Value::as_object)
}

fn account_id(record: &Value) -> Option<&str> {
    attribution(record)?.get("account_id")?.as_str()
}

#[test]
fn seeds_one_account_per_distinct_observed_configuration() {
    let mut records = vec![
        definition(
            "glm-a",
            Some("claude-code-glm"),
            None,
            serde_json::json!({}),
        ),
        definition(
            "glm-b",
            Some("claude-code-glm"),
            None,
            serde_json::json!({}),
        ),
        definition("cc", Some("claude"), None, serde_json::json!({})),
        definition(
            "aliyun",
            Some("claude-code-glm"),
            None,
            serde_json::json!({
                "OPENAI_COMPAT_BASE_URL":
                    "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1"
            }),
        ),
        definition("builtin-fizz", None, None, serde_json::json!({})),
    ];
    assert_eq!(
        seed_records(&mut records),
        4,
        "the runtime-less row is skipped"
    );

    assert_eq!(account_id(&records[0]), Some("harness=claude-code-glm"));
    assert_eq!(
        account_id(&records[1]),
        account_id(&records[0]),
        "identical observed configuration is one account"
    );
    assert_eq!(
        account_id(&records[2]),
        Some("harness=claude;credential=claude-cli-login")
    );
    assert_eq!(
        account_id(&records[3]),
        Some("harness=claude-code-glm;gateway=token-plan.ap-southeast-1.maas.aliyuncs.com")
    );
    assert_eq!(
        records[4].get("usage_attribution"),
        None,
        "a record with nothing recorded gets no attribution key at all"
    );
    for record in &records[..4] {
        assert_eq!(
            attribution(record).and_then(|a| a.get("confirmed")),
            Some(&Value::Bool(false)),
            "every seeded row is unconfirmed"
        );
    }
}

/// A linked instance inherits its definition's gateway at spawn, so it must be
/// filed under the same account as that definition — not a second one.
#[test]
fn instances_inherit_the_definition_env_layer_when_grouping() {
    let mut records = vec![
        definition(
            "pilot",
            Some("buzz-agent"),
            Some("openai-compat"),
            serde_json::json!({ "OPENAI_COMPAT_BASE_URL": "https://pilot.example.net:6250/v1" }),
        ),
        instance(
            "a".repeat(64).as_str(),
            Some("pilot"),
            Some("buzz-agent"),
            Some("openai-compat"),
            serde_json::json!({}),
        ),
    ];
    assert_eq!(seed_records(&mut records), 2);
    assert_eq!(
        account_id(&records[1]),
        account_id(&records[0]),
        "an instance must not be split from the definition whose gateway it inherits"
    );
    assert_eq!(
        account_id(&records[0]),
        Some("harness=buzz-agent;provider=openai-compat;gateway=pilot.example.net:6250")
    );
}

/// An instance override beats the inherited layer, exactly as `merged_user_env`
/// would at spawn.
#[test]
fn an_instance_gateway_override_splits_it_from_its_definition() {
    let mut records = vec![
        definition(
            "pilot",
            Some("buzz-agent"),
            Some("openai-compat"),
            serde_json::json!({ "OPENAI_COMPAT_BASE_URL": "https://pilot.example.net:6250/v1" }),
        ),
        instance(
            "b".repeat(64).as_str(),
            Some("pilot"),
            Some("buzz-agent"),
            Some("openai-compat"),
            serde_json::json!({ "OPENAI_COMPAT_BASE_URL": "https://other.example.net/v1" }),
        ),
    ];
    assert_eq!(seed_records(&mut records), 2);
    assert_ne!(account_id(&records[1]), account_id(&records[0]));
    assert_eq!(
        account_id(&records[1]),
        Some("harness=buzz-agent;provider=openai-compat;gateway=other.example.net")
    );
}

/// The model is never consulted, so two agents that differ only by model stay
/// in one account. (This is the 21 `opus` + 12 `fable` case.)
#[test]
fn agents_differing_only_by_model_share_one_account() {
    let with_model = |slug: &str, model: &str| {
        let mut record = definition(slug, Some("claude-code-glm"), None, serde_json::json!({}));
        record
            .as_object_mut()
            .unwrap()
            .insert("model".to_string(), Value::String(model.to_string()));
        record
    };
    let mut records = vec![with_model("a", "opus"), with_model("b", "fable")];
    assert_eq!(seed_records(&mut records), 2);
    assert_eq!(account_id(&records[0]), account_id(&records[1]));
}

/// Running twice writes nothing the second time, and never disturbs a row an
/// owner has confirmed or deliberately cleared.
#[test]
fn seeding_is_idempotent_and_preserves_owner_decisions() {
    let mut records = vec![
        definition("glm", Some("claude-code-glm"), None, serde_json::json!({})),
        serde_json::json!({
            "pubkey": "",
            "slug": "confirmed",
            "runtime": "claude-code-glm",
            "usage_attribution": {
                "provider": "zai",
                "account_id": "zai-coding-plan",
                "account_label": "Z.ai Coding Plan",
                "confirmed": true
            }
        }),
        serde_json::json!({
            "pubkey": "",
            "slug": "cleared",
            "runtime": "claude",
            "usage_attribution": { "confirmed": true }
        }),
    ];
    assert_eq!(seed_records(&mut records), 1);
    let first_pass = records.clone();
    assert_eq!(
        seed_records(&mut records),
        0,
        "a second boot must write nothing"
    );
    assert_eq!(records, first_pass);
    assert_eq!(account_id(&records[1]), Some("zai-coding-plan"));
    assert_eq!(
        attribution(&records[1]).and_then(|a| a.get("confirmed")),
        Some(&Value::Bool(true)),
        "a confirmation must survive a re-seed"
    );
    assert_eq!(
        account_id(&records[2]),
        None,
        "an owner-cleared row must not be resurrected"
    );
    assert_eq!(
        attribution(&records[2]).and_then(|a| a.get("confirmed")),
        Some(&Value::Bool(true))
    );
}

/// A store whose values are the wrong JSON type must not panic or invent an
/// identity out of them.
#[test]
fn malformed_records_are_skipped_rather_than_guessed_at() {
    let mut records = vec![
        serde_json::json!({ "pubkey": "", "slug": "x", "runtime": 7, "env_vars": "nope" }),
        serde_json::json!("not an object"),
        serde_json::json!({ "pubkey": "", "slug": "y", "runtime": "   " }),
        serde_json::json!({
            "pubkey": "",
            "slug": "z",
            "runtime": "buzz-agent",
            "env_vars": { "OPENAI_COMPAT_BASE_URL": 42 }
        }),
    ];
    assert_eq!(seed_records(&mut records), 1);
    assert_eq!(records[0].get("usage_attribution"), None);
    assert_eq!(records[2].get("usage_attribution"), None);
    assert_eq!(
        account_id(&records[3]),
        Some("harness=buzz-agent"),
        "a non-string gateway is not observed configuration"
    );
}

/// A credential sitting in `env_vars` is never read — not as a gateway, not as
/// an identity, and not into the label.
#[test]
fn credentials_in_env_vars_never_reach_the_seeded_row() {
    let mut records = vec![definition(
        "creds",
        Some("buzz-agent"),
        Some("anthropic"),
        serde_json::json!({
            "ANTHROPIC_API_KEY": "sk-ant-should-never-appear",
            "OPENAI_COMPAT_API_KEY": "sk-live-should-never-appear",
            "DATABRICKS_TOKEN": "dapi-should-never-appear"
        }),
    )];
    assert_eq!(seed_records(&mut records), 1);
    let serialized = serde_json::to_string(&records[0].get("usage_attribution")).unwrap();
    for secret in [
        "sk-ant-should-never-appear",
        "sk-live-should-never-appear",
        "dapi-should-never-appear",
    ] {
        assert!(
            !serialized.contains(secret),
            "seeded row leaked `{secret}`: {serialized}"
        );
    }
    assert_eq!(
        account_id(&records[0]),
        Some("harness=buzz-agent;provider=anthropic;credential=ANTHROPIC_API_KEY"),
        "only the credential's NAME is a grouping signal"
    );
}

/// The file and directory layer: what boot actually executes.
///
/// `seed_records` being correct proves nothing about any of this — the store
/// that gets opened, whether the bytes reach the file the app later reads, or
/// whether a second launch leaves an owner's decision alone on disk. These
/// tests drive real stores in temp directories, the same way
/// [`super::super::materialize`]'s tests do.
mod on_disk {
    use super::super::{
        seed_target_dirs, seed_usage_attribution_in_dirs, seed_usage_attribution_in_file,
    };
    use crate::migration::test_support::{read_agents_json, write_agents_json};
    use serde_json::Value;
    use std::path::{Path, PathBuf};

    /// The real canonical dev data directory name, spelled out rather than read
    /// from `CANONICAL_DEV_IDENTIFIER`: an expectation phrased in terms of the
    /// constant it pins cannot fail when that constant changes, and this name
    /// is the one dev worktree instances actually share on disk.
    const CANONICAL_DEV_DIR: &str = "xyz.block.buzz.app.dev";

    fn store(dir: &Path) -> PathBuf {
        dir.join("agents/managed-agents.json")
    }

    /// A store shaped like the real one: two agents on one custom harness, one
    /// on a builtin, one behind its own gateway, and one with no runtime at all.
    fn real_shaped_store() -> Value {
        serde_json::json!([
            { "pubkey": "", "slug": "glm-a", "runtime": "claude-code-glm" },
            { "pubkey": "", "slug": "glm-b", "runtime": "claude-code-glm" },
            { "pubkey": "", "slug": "cc", "runtime": "claude" },
            {
                "pubkey": "", "slug": "pilot", "runtime": "buzz-agent",
                "provider": "openai-compat",
                "env_vars": { "OPENAI_COMPAT_BASE_URL": "https://pilot.example.net:6250/v1" }
            },
            { "pubkey": "", "slug": "builtin-fizz", "runtime": null },
        ])
    }

    fn attributed(records: &[Value]) -> usize {
        records
            .iter()
            .filter(|record| record.get("usage_attribution").is_some())
            .count()
    }

    fn account_id(record: &Value) -> Option<&str> {
        record.get("usage_attribution")?.get("account_id")?.as_str()
    }

    /// Seeding a real store on disk writes the rows into that file.
    #[test]
    fn seeding_a_store_on_disk_writes_the_rows() {
        let dir = tempfile::tempdir().unwrap();
        write_agents_json(dir.path(), &real_shaped_store());
        seed_usage_attribution_in_file(&store(dir.path()));

        let records = read_agents_json(dir.path());
        assert_eq!(records.len(), 5, "no record may be lost by the rewrite");
        assert_eq!(attributed(&records), 4, "four of five rows are seedable");
        assert_eq!(account_id(&records[0]), Some("harness=claude-code-glm"));
        assert_eq!(
            account_id(&records[2]),
            Some("harness=claude;credential=claude-cli-login")
        );
        assert_eq!(
            account_id(&records[3]),
            Some("harness=buzz-agent;provider=openai-compat;gateway=pilot.example.net:6250")
        );
        for record in &records[..4] {
            assert_eq!(
                record.get("usage_attribution").unwrap().get("confirmed"),
                Some(&Value::Bool(false)),
                "a seeded row on disk is unconfirmed"
            );
        }
    }

    /// A record with no recorded runtime, provider or gateway keeps the field
    /// absent on disk — not null, not a placeholder, not a shared bucket.
    #[test]
    fn a_runtime_null_record_keeps_the_field_absent_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        write_agents_json(dir.path(), &real_shaped_store());
        seed_usage_attribution_in_file(&store(dir.path()));

        let records = read_agents_json(dir.path());
        let builtin = records[4].as_object().unwrap();
        assert_eq!(
            builtin.get("slug").and_then(Value::as_str),
            Some("builtin-fizz")
        );
        assert!(
            !builtin.contains_key("usage_attribution"),
            "the key itself must be absent, so a later boot can still decide: {builtin:?}"
        );
    }

    /// A second launch rewrites nothing at all.
    #[test]
    fn seeding_on_disk_is_idempotent_across_two_runs() {
        let dir = tempfile::tempdir().unwrap();
        write_agents_json(dir.path(), &real_shaped_store());
        let path = store(dir.path());

        seed_usage_attribution_in_file(&path);
        let after_first = std::fs::read_to_string(&path).unwrap();
        assert_eq!(attributed(&read_agents_json(dir.path())), 4);

        seed_usage_attribution_in_file(&path);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            after_first,
            "a second launch must leave the file byte-identical"
        );
    }

    /// An owner-confirmed row on disk survives a launch untouched.
    #[test]
    fn seeding_on_disk_preserves_an_existing_confirmed_row() {
        let dir = tempfile::tempdir().unwrap();
        write_agents_json(
            dir.path(),
            &serde_json::json!([
                {
                    "pubkey": "", "slug": "confirmed", "runtime": "claude-code-glm",
                    "usage_attribution": {
                        "provider": "zai",
                        "account_id": "zai-coding-plan",
                        "account_label": "Z.ai Coding Plan",
                        "confirmed": true
                    }
                },
                { "pubkey": "", "slug": "fresh", "runtime": "claude-code-glm" },
            ]),
        );
        seed_usage_attribution_in_file(&store(dir.path()));

        let records = read_agents_json(dir.path());
        assert_eq!(account_id(&records[0]), Some("zai-coding-plan"));
        assert_eq!(
            records[0]
                .get("usage_attribution")
                .unwrap()
                .get("confirmed"),
            Some(&Value::Bool(true)),
            "the owner's confirmation must survive the launch"
        );
        assert_eq!(account_id(&records[1]), Some("harness=claude-code-glm"));
    }

    /// A store that is not there is a no-op: no directory, no file, no panic.
    #[test]
    fn a_missing_store_is_a_safe_no_op() {
        let dir = tempfile::tempdir().unwrap();
        seed_usage_attribution_in_dirs(&[dir.path().to_path_buf()]);
        assert!(
            !store(dir.path()).exists(),
            "seeding must never manufacture an agent store"
        );
    }

    /// An unparseable store is left exactly as it was, rather than replaced by
    /// a well-formed empty one.
    #[test]
    fn an_unparseable_store_is_left_untouched() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("agents")).unwrap();
        let path = store(dir.path());
        std::fs::write(&path, b"{ not an array").unwrap();

        seed_usage_attribution_in_dirs(&[dir.path().to_path_buf()]);
        assert_eq!(
            std::fs::read(&path).unwrap(),
            b"{ not an array",
            "a store this migration cannot read must not be rewritten"
        );
    }

    /// The regression test for the boot behaviour: a dev worktree instance's
    /// own data dir AND the canonical dev data dir it shares the machine with
    /// are both resolved, in that order, and both stores are actually written.
    ///
    /// This is the layer a decision-only test cannot see. Narrow the directory
    /// list, or stop writing, and the rows land in a store the app never reads.
    #[test]
    fn seeding_covers_the_instance_dir_and_the_canonical_dev_dir() {
        let support = tempfile::tempdir().unwrap();
        let instance = support.path().join("xyz.block.buzz.app.dev.my-branch");
        let canonical = support.path().join(CANONICAL_DEV_DIR);
        write_agents_json(&instance, &real_shaped_store());
        write_agents_json(&canonical, &real_shaped_store());

        let dirs = seed_target_dirs(&instance);
        assert_eq!(
            dirs,
            vec![instance.clone(), canonical.clone()],
            "the instance's own dir comes first, then the canonical dev dir"
        );

        seed_usage_attribution_in_dirs(&dirs);
        assert_eq!(
            attributed(&read_agents_json(&instance)),
            4,
            "the instance's own store must be seeded"
        );
        assert_eq!(
            attributed(&read_agents_json(&canonical)),
            4,
            "the canonical dev store a worktree instance shares must be seeded too"
        );
    }

    /// A canonical dev dir that does not exist is not in the list, so no store
    /// is manufactured beside an unrelated app-data directory.
    #[test]
    fn seed_target_dirs_skips_a_canonical_dev_dir_that_does_not_exist() {
        let support = tempfile::tempdir().unwrap();
        let instance = support.path().join("xyz.block.buzz.app.dev.my-branch");
        std::fs::create_dir_all(&instance).unwrap();
        assert_eq!(seed_target_dirs(&instance), vec![instance]);
    }

    /// The canonical dev instance itself resolves to one directory, not two
    /// passes over the same file.
    #[test]
    fn seed_target_dirs_lists_the_canonical_dev_dir_once() {
        let support = tempfile::tempdir().unwrap();
        let canonical = support.path().join(CANONICAL_DEV_DIR);
        std::fs::create_dir_all(&canonical).unwrap();
        assert_eq!(seed_target_dirs(&canonical), vec![canonical]);
    }

    /// A dev worktree instance's store is a symlink into the canonical dev
    /// directory. Writing through it must update the shared file the app reads,
    /// and must not replace the symlink with a divergent copy.
    #[cfg(unix)]
    #[test]
    fn seeding_through_a_worktree_symlink_writes_the_shared_store() {
        let support = tempfile::tempdir().unwrap();
        let canonical = support.path().join(CANONICAL_DEV_DIR);
        let instance = support.path().join("xyz.block.buzz.app.dev.my-branch");
        write_agents_json(&canonical, &real_shaped_store());
        std::fs::create_dir_all(instance.join("agents")).unwrap();
        std::os::unix::fs::symlink(store(&canonical), store(&instance)).unwrap();

        seed_usage_attribution_in_file(&store(&instance));

        assert_eq!(
            attributed(&read_agents_json(&canonical)),
            4,
            "the shared canonical file is the one the app reads, so it must carry the rows"
        );
        assert!(
            std::fs::symlink_metadata(store(&instance))
                .unwrap()
                .file_type()
                .is_symlink(),
            "the instance store must still be a symlink, not a divergent copy"
        );
    }
}
