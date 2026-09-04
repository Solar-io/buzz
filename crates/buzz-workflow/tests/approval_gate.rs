//! The approval gate, end to end inside the engine (WF-08).
//!
//! Before this, `RequestApproval` returned a token and threw it away: no
//! `workflow_approvals` row was written by any production path, the run was
//! marked `failed` with `approval_not_supported`, and no kind:46010 was ever
//! published. These tests pin the three things that changed — a durable record,
//! a run parked in `waiting_approval`, and an announcement carrying the same
//! reference the record is keyed by.
//!
//! # Running
//!
//! ```text
//! BUZZ_TEST_DATABASE_URL=postgres://buzz:buzz_dev@localhost:5432/<db> \
//!   cargo test -p buzz-workflow --test approval_gate -- --ignored
//! ```

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use buzz_core::tenant::CommunityId;
use buzz_db::workflow::{ApprovalStatus, RunStatus};
use buzz_db::Db;
use buzz_workflow::action_sink::{ActionSink, ActionSinkError, WorkflowEvent};
use buzz_workflow::executor::{RunRef, TriggerContext};
use buzz_workflow::{WorkflowConfig, WorkflowEngine};
use uuid::Uuid;

/// Records what the engine asked the relay to publish, and answers approver
/// resolution from a fixed table so these tests do not need a channel roster.
///
/// Deliberately *not* inert: every method does the work its production
/// counterpart's caller depends on (returning an event id, returning a resolved
/// spec, failing an unresolvable one), so a step that never ran is visible as an
/// empty recording rather than as a silent success.
#[derive(Default)]
struct RecordingSink {
    emitted: Mutex<Vec<WorkflowEvent>>,
    /// `@Name` → pubkey hex. Anything else is unresolvable.
    approvers: Vec<(String, String)>,
    /// When set, `emit_workflow_event` fails with this message.
    emit_failure: Option<String>,
}

impl RecordingSink {
    fn with_approver(name: &str, pubkey_hex: &str) -> Self {
        Self {
            approvers: vec![(name.to_owned(), pubkey_hex.to_owned())],
            ..Default::default()
        }
    }

    fn failing_emit(message: &str) -> Self {
        Self {
            emit_failure: Some(message.to_owned()),
            ..Default::default()
        }
    }

    fn emitted(&self) -> Vec<WorkflowEvent> {
        self.emitted.lock().expect("sink lock").clone()
    }

    fn of_kind(&self, kind: u32) -> Vec<WorkflowEvent> {
        self.emitted()
            .into_iter()
            .filter(|event| event.kind == kind)
            .collect()
    }
}

impl ActionSink for RecordingSink {
    fn send_message(
        &self,
        _community_id: CommunityId,
        _channel_id: &str,
        _text: &str,
        _author_pubkey: &str,
        _reply_to: Option<&str>,
    ) -> Pin<Box<dyn Future<Output = Result<String, ActionSinkError>> + Send + '_>> {
        Box::pin(async move { Ok(Uuid::new_v4().simple().to_string()) })
    }

    fn emit_workflow_event(
        &self,
        _community_id: CommunityId,
        event: WorkflowEvent,
    ) -> Pin<Box<dyn Future<Output = Result<Option<String>, ActionSinkError>> + Send + '_>> {
        Box::pin(async move {
            if let Some(message) = &self.emit_failure {
                return Err(ActionSinkError::Database(message.clone()));
            }
            self.emitted.lock().expect("sink lock").push(event);
            Ok(Some(Uuid::new_v4().simple().to_string()))
        })
    }

    fn resolve_approver(
        &self,
        _community_id: CommunityId,
        _workflow_id: Uuid,
        spec: &str,
    ) -> Pin<Box<dyn Future<Output = Result<String, ActionSinkError>> + Send + '_>> {
        let spec = spec.trim().to_owned();
        Box::pin(async move {
            if spec.is_empty() || spec == "any" {
                return Ok("any".to_owned());
            }
            match self
                .approvers
                .iter()
                .find(|(name, _)| name.eq_ignore_ascii_case(&spec))
            {
                Some((_, pubkey)) => Ok(pubkey.clone()),
                None => Err(ActionSinkError::ApproverUnresolved(spec)),
            }
        })
    }
}

async fn test_db() -> Db {
    let url = std::env::var("BUZZ_TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .expect("BUZZ_TEST_DATABASE_URL or DATABASE_URL must point at an isolated test database");
    let pool = sqlx::PgPool::connect(&url)
        .await
        .expect("connect to test database");
    let db = Db::from_pool(pool);
    db.migrate().await.expect("migrate test database");
    db
}

/// A community with a channel and a workflow whose single step is an approval
/// gate. Returns the pieces a run needs.
struct Fixture {
    db: Db,
    community: CommunityId,
    workflow_id: Uuid,
}

async fn fixture(db: Db, approver_spec: &str, extra_steps: &str) -> Fixture {
    let host = format!("wf08-{}.example", Uuid::new_v4().simple());
    let community = db
        .ensure_configured_community(&host)
        .await
        .expect("create community")
        .id;
    let owner = vec![0x11; 32];
    db.ensure_user(community, &owner)
        .await
        .expect("ensure owner");
    let channel = db
        .create_channel(
            community,
            "approvals",
            buzz_db::channel::ChannelType::Stream,
            buzz_db::channel::ChannelVisibility::Open,
            None,
            &owner,
            None,
        )
        .await
        .expect("create channel")
        .id;

    let yaml = format!(
        "name: Gate\ntrigger:\n  on: webhook\nsteps:\n  \
         - id: gate\n    action: request_approval\n    from: '{approver_spec}'\n    \
         message: Ship it?\n    timeout: 2h\n{extra_steps}"
    );
    let (_, definition_json) = WorkflowEngine::parse_yaml(&yaml).expect("parse workflow yaml");
    let workflow_id = db
        .create_workflow(
            community,
            Some(channel),
            &owner,
            "Gate",
            &definition_json,
            &[0x22; 32],
        )
        .await
        .expect("create workflow");

    Fixture {
        db,
        community,
        workflow_id,
    }
}

fn engine_with(db: Db, sink: Arc<RecordingSink>) -> Arc<WorkflowEngine> {
    let engine = Arc::new(WorkflowEngine::new(db, WorkflowConfig::default()));
    engine.set_action_sink(sink);
    engine
}

async fn run_to_gate(fixture: &Fixture, engine: &WorkflowEngine) -> (Uuid, RunRef) {
    let run_id = fixture
        .db
        .create_workflow_run(fixture.community, fixture.workflow_id, None, None)
        .await
        .expect("create run");
    let run = RunRef::new(fixture.community, fixture.workflow_id, run_id);
    let def: buzz_workflow::WorkflowDef = serde_json::from_value(
        fixture
            .db
            .get_workflow(fixture.community, fixture.workflow_id)
            .await
            .expect("load workflow")
            .definition,
    )
    .expect("parse stored definition");
    let result =
        buzz_workflow::executor::execute_run(engine, run, &def, &TriggerContext::default()).await;
    engine.finalize_run(run, result, None).await;
    (run_id, run)
}

/// The gate writes a real `workflow_approvals` row, and the row says which step
/// of which run it is holding.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn approval_gate_mints_a_pending_record() {
    let db = test_db().await;
    let fixture = fixture(db.clone(), "any", "").await;
    let sink = Arc::new(RecordingSink::default());
    let engine = engine_with(db.clone(), Arc::clone(&sink));

    let (run_id, _) = run_to_gate(&fixture, &engine).await;

    let approvals = db
        .get_run_approvals(fixture.community, fixture.workflow_id, run_id)
        .await
        .expect("read approvals");
    assert_eq!(
        approvals.len(),
        1,
        "the gate must mint exactly one approval record"
    );
    let approval = &approvals[0];
    assert_eq!(approval.status, ApprovalStatus::Pending);
    assert_eq!(approval.step_id, "gate");
    assert_eq!(approval.step_index, 0);
    assert_eq!(approval.approver_spec, "any");
    assert_eq!(approval.run_id, run_id);
}

/// A suspended run parks in `waiting_approval` — the state the relay's decision
/// handler requires before it will resume or cancel. It used to land in
/// `failed` with code `approval_not_supported`.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn suspended_run_waits_for_approval_rather_than_failing() {
    let db = test_db().await;
    let fixture = fixture(db.clone(), "any", "").await;
    let sink = Arc::new(RecordingSink::default());
    let engine = engine_with(db.clone(), Arc::clone(&sink));

    let (run_id, _) = run_to_gate(&fixture, &engine).await;

    let run = db
        .get_workflow_run(fixture.community, run_id)
        .await
        .expect("read run");
    assert_eq!(run.status, RunStatus::WaitingApproval);
    assert_eq!(
        run.current_step, 0,
        "the run must record the index of the suspending step; the relay resumes at index + 1"
    );
}

/// The kind:46010 announcement names the same approval the DB row is keyed by.
///
/// The expectation is cross-checked against the stored `token` column rather
/// than recomputed from the token the executor returned: an assertion that
/// re-derived the hash the same way the code does would still pass if both
/// sides drifted together.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn approval_request_event_references_the_stored_record() {
    let db = test_db().await;
    let fixture = fixture(db.clone(), "any", "").await;
    let sink = Arc::new(RecordingSink::default());
    let engine = engine_with(db.clone(), Arc::clone(&sink));

    let (run_id, _) = run_to_gate(&fixture, &engine).await;

    let approvals = db
        .get_run_approvals(fixture.community, fixture.workflow_id, run_id)
        .await
        .expect("read approvals");
    let stored_ref = hex::encode(&approvals[0].token);

    let requests = sink.of_kind(46010);
    assert_eq!(
        requests.len(),
        1,
        "exactly one approval request must be announced"
    );
    let request = &requests[0];
    assert_eq!(request.approval_ref.as_deref(), Some(stored_ref.as_str()));
    assert_eq!(request.step_id.as_deref(), Some("gate"));
    assert_eq!(request.run_id, run_id);
    assert_eq!(request.workflow_id, fixture.workflow_id);
    assert_eq!(
        request.content, "Ship it?",
        "clients render the content of a 46010 directly, so it carries the message"
    );
}

/// The raw token stays inside the relay. `approval_ref` is a hash, so it must
/// not be a value that hashes to itself — and in particular must not equal the
/// token the executor handed back.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn approval_request_event_never_carries_the_raw_token() {
    let db = test_db().await;
    let fixture = fixture(db.clone(), "any", "").await;
    let sink = Arc::new(RecordingSink::default());
    let engine = engine_with(db.clone(), Arc::clone(&sink));

    let run_id = db
        .create_workflow_run(fixture.community, fixture.workflow_id, None, None)
        .await
        .expect("create run");
    let run = RunRef::new(fixture.community, fixture.workflow_id, run_id);
    let def: buzz_workflow::WorkflowDef = serde_json::from_value(
        db.get_workflow(fixture.community, fixture.workflow_id)
            .await
            .expect("load workflow")
            .definition,
    )
    .expect("parse stored definition");
    let result =
        buzz_workflow::executor::execute_run(&engine, run, &def, &TriggerContext::default())
            .await
            .expect("run suspends at the gate");
    let token = result
        .approval_token
        .expect("the gate must return its token to the caller");

    let request = sink.of_kind(46010).pop().expect("46010 emitted");
    let announced = request.approval_ref.expect("approval ref");
    assert_ne!(
        announced, token,
        "the wire reference must be the token's hash, never the token"
    );
    assert!(
        !request.content.contains(&token),
        "the token must not leak through the message body either"
    );
    assert_eq!(announced.len(), 64, "a SHA-256 hex digest is 64 chars");
}

/// An approver spec the relay's decision check could never honour fails the
/// step. The alternative — minting it anyway — suspends the run behind an
/// approval nobody is able to grant, until a timeout that sweeps nothing.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn unresolvable_approver_fails_the_step_instead_of_hanging_the_run() {
    let db = test_db().await;
    let fixture = fixture(db.clone(), "@nobody-here", "").await;
    let sink = Arc::new(RecordingSink::with_approver(
        "@release-manager",
        &"a".repeat(64),
    ));
    let engine = engine_with(db.clone(), Arc::clone(&sink));

    let (run_id, _) = run_to_gate(&fixture, &engine).await;

    let run = db
        .get_workflow_run(fixture.community, run_id)
        .await
        .expect("read run");
    assert_eq!(run.status, RunStatus::Failed);
    let approvals = db
        .get_run_approvals(fixture.community, fixture.workflow_id, run_id)
        .await
        .expect("read approvals");
    assert!(
        approvals.is_empty(),
        "a step that could not resolve its approver must not leave a pending record behind"
    );
}

/// A named approver is stored in the narrow form the relay's decision check
/// accepts — an exact pubkey — not as the `@Name` the YAML wrote.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn named_approver_is_stored_as_a_pubkey() {
    let db = test_db().await;
    let approver = "b".repeat(64);
    let fixture = fixture(db.clone(), "@release-manager", "").await;
    let sink = Arc::new(RecordingSink::with_approver("@release-manager", &approver));
    let engine = engine_with(db.clone(), Arc::clone(&sink));

    let (run_id, _) = run_to_gate(&fixture, &engine).await;

    let approvals = db
        .get_run_approvals(fixture.community, fixture.workflow_id, run_id)
        .await
        .expect("read approvals");
    assert_eq!(approvals.len(), 1);
    assert_eq!(approvals[0].approver_spec, approver);

    let request = sink.of_kind(46010).pop().expect("46010 emitted");
    assert!(
        request.notify_pubkeys.contains(&approver),
        "the designated approver must be notified: clients filter 46010 on #p"
    );
}

/// If the announcement cannot be published, the step fails *and* the record it
/// had already written is retired.
///
/// The status assertion alone would not discriminate — a mutation that failed
/// every suspended run would satisfy it. The load-bearing half is the second:
/// a `pending` approval left behind for a run that has failed would surface in
/// the approvals view and invite a decision that can never resume anything.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn failure_to_announce_retires_the_unannounced_record() {
    let db = test_db().await;
    let fixture = fixture(db.clone(), "any", "").await;
    let sink = Arc::new(RecordingSink::failing_emit("fan-out is down"));
    let engine = engine_with(db.clone(), Arc::clone(&sink));

    let (run_id, _) = run_to_gate(&fixture, &engine).await;

    let run = db
        .get_workflow_run(fixture.community, run_id)
        .await
        .expect("read run");
    assert_eq!(
        run.status,
        RunStatus::Failed,
        "a gate whose 46010 did not publish must not report itself as waiting"
    );

    let approvals = db
        .get_run_approvals(fixture.community, fixture.workflow_id, run_id)
        .await
        .expect("read approvals");
    assert_eq!(
        approvals.len(),
        1,
        "the record was written before the publish"
    );
    assert_eq!(
        approvals[0].status,
        ApprovalStatus::Expired,
        "an approval nobody was told about must not stay pending"
    );
}

/// The run's own lifecycle is observable over Nostr: a run that reaches the gate
/// announces itself, starts its step, and publishes nothing that claims it
/// finished.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn run_publishes_its_lifecycle() {
    let db = test_db().await;
    let fixture = fixture(db.clone(), "any", "").await;
    let sink = Arc::new(RecordingSink::default());
    let engine = engine_with(db.clone(), Arc::clone(&sink));

    let (run_id, _) = run_to_gate(&fixture, &engine).await;

    assert_eq!(sink.of_kind(46001).len(), 1, "one workflow-triggered event");
    let started = sink.of_kind(46002);
    assert_eq!(started.len(), 1, "one step-started event for the gate");
    assert_eq!(started[0].step_id.as_deref(), Some("gate"));
    assert_eq!(started[0].run_id, run_id);
    assert!(
        sink.of_kind(46005).is_empty(),
        "a suspended run has not completed"
    );
    assert!(
        sink.of_kind(46006).is_empty(),
        "a suspended run has not failed"
    );
}

/// A run with no approval gate reports completion, and every event it published
/// is one of the kinds the registry reserves for execution history.
#[tokio::test]
#[ignore = "requires Postgres"]
async fn completed_run_publishes_completion() {
    let db = test_db().await;
    let host = format!("wf08-{}.example", Uuid::new_v4().simple());
    let community = db
        .ensure_configured_community(&host)
        .await
        .expect("create community")
        .id;
    let owner = vec![0x33; 32];
    db.ensure_user(community, &owner)
        .await
        .expect("ensure owner");
    let channel = db
        .create_channel(
            community,
            "plain",
            buzz_db::channel::ChannelType::Stream,
            buzz_db::channel::ChannelVisibility::Open,
            None,
            &owner,
            None,
        )
        .await
        .expect("create channel")
        .id;
    let yaml = "name: Plain\ntrigger:\n  on: webhook\nsteps:\n  \
                - id: wait\n    action: delay\n    duration: 1s\n";
    let (_, definition_json) = WorkflowEngine::parse_yaml(yaml).expect("parse yaml");
    let workflow_id = db
        .create_workflow(
            community,
            Some(channel),
            &owner,
            "Plain",
            &definition_json,
            &[0x44; 32],
        )
        .await
        .expect("create workflow");

    let sink = Arc::new(RecordingSink::default());
    let engine = engine_with(db.clone(), Arc::clone(&sink));
    let run_id = db
        .create_workflow_run(community, workflow_id, None, None)
        .await
        .expect("create run");
    let run = RunRef::new(community, workflow_id, run_id);
    let def: buzz_workflow::WorkflowDef = serde_json::from_value(
        db.get_workflow(community, workflow_id)
            .await
            .expect("load workflow")
            .definition,
    )
    .expect("parse definition");
    let result =
        buzz_workflow::executor::execute_run(&engine, run, &def, &TriggerContext::default()).await;
    engine.finalize_run(run, result, None).await;

    assert_eq!(sink.of_kind(46001).len(), 1, "triggered");
    assert_eq!(sink.of_kind(46002).len(), 1, "step started");
    assert_eq!(sink.of_kind(46003).len(), 1, "step completed");
    assert_eq!(sink.of_kind(46005).len(), 1, "run completed");
    assert!(sink.of_kind(46010).is_empty(), "no approval was requested");

    let emitted = sink.emitted();
    assert_eq!(emitted.len(), 4, "no other events were published");
    for event in emitted {
        assert!(
            buzz_core::kind::is_workflow_execution_kind(event.kind),
            "kind {} is outside the 46001-46012 execution range",
            event.kind
        );
    }

    let stored = db
        .get_workflow_run(community, run_id)
        .await
        .expect("read run");
    assert_eq!(stored.status, RunStatus::Completed);
}
