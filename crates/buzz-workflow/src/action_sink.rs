//! Action sink trait — interface for workflow side-effects.
//!
//! The relay implements [`ActionSink`] to provide direct DB access to the
//! executor, replacing the HTTP loopback pattern.

use std::future::Future;
use std::pin::Pin;

use buzz_core::tenant::CommunityId;
use uuid::Uuid;

/// A workflow execution event (kind 46001–46012) to publish.
///
/// The relay signs, persists and fans these out; the executor only decides
/// *what* happened. See [`buzz_core::kind`] for the wire contract these fields
/// map onto — `workflow_id` becomes the `d` tag, `run_id` the `run` tag, and so
/// on. Fields are owned so the value can cross an `async` boundary without
/// borrowing the executor's step state.
#[derive(Debug, Clone)]
pub struct WorkflowEvent {
    /// Event kind — one of the 46001–46012 execution kinds.
    pub kind: u32,
    /// The workflow this run belongs to (`d` tag).
    pub workflow_id: Uuid,
    /// The run being reported on (`run` tag).
    pub run_id: Uuid,
    /// Step id for step-level and approval events (`step` tag).
    pub step_id: Option<String>,
    /// Approval reference — hex of the stored token hash — for 46010/46011/46012
    /// (`approval` tag). Never the raw token.
    pub approval_ref: Option<String>,
    /// Extra hex pubkeys to `p`-tag beyond the workflow owner: the designated
    /// approver on 46010, the deciding approver on 46011/46012.
    pub notify_pubkeys: Vec<String>,
    /// Event content. JSON for 46001–46007; human-readable text for
    /// 46010–46012, which clients render directly.
    pub content: String,
}

impl WorkflowEvent {
    /// Create an execution event with no step, approval, or extra recipients.
    pub fn new(kind: u32, workflow_id: Uuid, run_id: Uuid, content: String) -> Self {
        Self {
            kind,
            workflow_id,
            run_id,
            step_id: None,
            approval_ref: None,
            notify_pubkeys: Vec::new(),
            content,
        }
    }

    /// Attach the step id this event describes.
    #[must_use]
    pub fn with_step(mut self, step_id: impl Into<String>) -> Self {
        self.step_id = Some(step_id.into());
        self
    }

    /// Attach the approval reference (hex of the stored token hash).
    #[must_use]
    pub fn with_approval_ref(mut self, approval_ref: impl Into<String>) -> Self {
        self.approval_ref = Some(approval_ref.into());
        self
    }

    /// Add a hex pubkey to `p`-tag alongside the workflow owner.
    #[must_use]
    pub fn notifying(mut self, pubkey_hex: impl Into<String>) -> Self {
        self.notify_pubkeys.push(pubkey_hex.into());
        self
    }
}

/// Errors from action sink operations.
#[derive(Debug, thiserror::Error)]
pub enum ActionSinkError {
    /// An input parameter is malformed (e.g. invalid UUID).
    #[error("invalid input: {0}")]
    InvalidInput(String),
    /// The target channel does not exist.
    #[error("channel not found: {0}")]
    ChannelNotFound(String),
    /// The target channel is archived.
    #[error("channel is archived: {0}")]
    ChannelArchived(String),
    /// Nostr event construction or signing failed.
    #[error("event construction failed: {0}")]
    EventBuild(String),
    /// A database operation failed.
    #[error("database error: {0}")]
    Database(String),
    /// Message content is empty or whitespace-only.
    #[error("empty message content")]
    EmptyContent,
    /// An approver spec named nobody the relay could resolve to a single
    /// pubkey. Fails the step rather than minting an approval nobody can act
    /// on — a workflow that hangs until its 24h timeout reports nothing.
    #[error("unresolved approver: {0}")]
    ApproverUnresolved(String),
}

impl From<ActionSinkError> for crate::WorkflowError {
    fn from(e: ActionSinkError) -> Self {
        crate::WorkflowError::WebhookError(e.to_string())
    }
}

/// Interface for workflow actions that produce side effects.
///
/// Implemented by the relay to provide direct DB/event access to the executor.
/// This replaces the HTTP loopback where the executor POSTed to the relay's
/// REST API (which failed with 401 auth errors).
///
/// Returns `Pin<Box<dyn Future>>` for dyn-compatibility — required because
/// `WorkflowEngine` stores `Arc<dyn ActionSink>`.
pub trait ActionSink: Send + Sync {
    /// Post a message to a channel on behalf of a workflow owner.
    ///
    /// - `community_id`: the server-resolved community that owns the workflow
    ///   run driving this side effect. The relay-signed message is published
    ///   under *this* community, never the deployment/default tenant — the run
    ///   carries its owning community so a workflow in community B posts into B
    ///   even though the side effect has no inbound connection to bind.
    /// - `channel_id`: UUID string of the target channel
    /// - `text`: message body (must not be empty/whitespace-only)
    /// - `author_pubkey`: hex-encoded pubkey of the workflow owner (used for
    ///   the `p` attribution tag; the relay keypair signs the event)
    /// - `reply_to`: when `Some(event_id_hex)`, the message is posted as a
    ///   threaded reply to that event (NIP-10 root/reply tags + real thread
    ///   metadata); when `None`, it is a top-level channel message.
    ///
    /// Returns the event ID hex string on success.
    fn send_message(
        &self,
        community_id: CommunityId,
        channel_id: &str,
        text: &str,
        author_pubkey: &str,
        reply_to: Option<&str>,
    ) -> Pin<Box<dyn Future<Output = Result<String, ActionSinkError>> + Send + '_>>;

    /// Publish a workflow execution event (kind 46001–46012).
    ///
    /// The relay signs it with its own keypair, scopes it to the workflow's
    /// channel, persists it, and fans it out. Returns the event id hex.
    ///
    /// Callers treat emission as best-effort *observability* — a fan-out
    /// failure must not fail a run that already did its work — with one
    /// exception: kind:46010 is the only way an approver learns a decision is
    /// pending, so the approval gate propagates its failure and fails the step.
    ///
    /// A workflow with no channel scope has nowhere safe to publish; the relay
    /// returns `Ok` having emitted nothing rather than posting a community-wide
    /// event that leaks workflow and run ids.
    fn emit_workflow_event(
        &self,
        community_id: CommunityId,
        event: WorkflowEvent,
    ) -> Pin<Box<dyn Future<Output = Result<Option<String>, ActionSinkError>> + Send + '_>>;

    /// Normalize a workflow definition's `request_approval.from` spec into a
    /// form the relay's approver check accepts: `"any"`, or a 64-char lowercase
    /// hex pubkey.
    ///
    /// `""`, `"any"` and `"@any"` normalize to `"any"`. A bare 64-hex pubkey is
    /// lowercased. An `@Name` is resolved against the workflow channel's
    /// members using the same exact-display-name contract the workflow message
    /// path uses for mentions, so approvals name people the way messages do.
    ///
    /// Returns [`ActionSinkError::ApproverUnresolved`] when a name matches no
    /// member or more than one, and for any other spec shape. Resolving at mint
    /// time keeps the stored `approver_spec` inside the narrow set the relay's
    /// decision handler will honour — an unresolvable spec fails the step
    /// loudly instead of minting an approval nobody is able to act on.
    fn resolve_approver(
        &self,
        community_id: CommunityId,
        channel_id: Uuid,
        spec: &str,
    ) -> Pin<Box<dyn Future<Output = Result<String, ActionSinkError>> + Send + '_>>;
}
