/**
 * Write-side event templates for the projects surface.
 *
 * Every tag layout here is the one the Rust builders emit, so an event this
 * client signs is indistinguishable from one `buzz` (the CLI) or the relay SDK
 * produced:
 *
 * - issue  → `build_git_issue`  (crates/buzz-sdk/src/builders.rs) —
 *   `["a", repo]`, `["p", owner]`, `["p", …recipients]`, `["subject", …]`,
 *   then one `["t", …]` per label.
 * - status → `build_git_status` (same file) —
 *   `["e", root, "", "root"]`, `["p", …recipients]`, `["a", repo]`.
 * - project → NIP-MP kind:30621, validated through the same envelope checker
 *   the read path uses, which mirrors the relay's `validate_project_envelope`.
 *
 * Nothing here signs or publishes: these are templates, so the pure logic is
 * testable under `node --test` with no relay, no signer and no DOM.
 */

import {
  KIND_GIT_ISSUE,
  KIND_PROJECT_ANNOUNCEMENT,
  KIND_REPO_ANNOUNCEMENT,
  KIND_TEXT_NOTE,
} from "./kinds.ts";
import {
  STATUS_KIND_BY_LIFECYCLE,
  type IssueLifecycle,
} from "./projectIssues.ts";
import {
  isValidProjectChannelId,
  validateProjectEventEnvelope,
} from "./projectModels.ts";

export type EventTemplate = {
  kind: number;
  content: string;
  tags: string[][];
};

const MAX_ISSUE_SUBJECT_LENGTH = 256;
const MAX_PROJECT_NAME_BYTES = 256;
const MAX_PROJECT_DESCRIPTION_BYTES = 2_048;

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isHex64(value: string): boolean {
  return /^[a-fA-F0-9]{64}$/.test(value);
}

/**
 * Slug for the `d` tag. Lowercased and hyphen-joined so the coordinate is
 * URL-safe and reproducible from the name the user typed.
 */
export function projectDtagFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export type InitialProjectTemplates = {
  dtag: string;
  project: EventTemplate;
  repository: EventTemplate;
  repositoryAddress: string;
};

/**
 * Creating a project publishes two events: the kind:30617 repository the
 * project is about, and the kind:30621 project that lists it. The project
 * alone would be an empty container, and the repository alone would render as
 * an implicit card with no grouping — the pair is what makes a project.
 *
 * Both carry the same `d` slug, so the project claims its own repository under
 * fold step 3 (same signer, same owner) and the repository does not also
 * appear as a standalone card.
 */
export function buildInitialProjectTemplates({
  channelId,
  cloneUrl,
  description,
  name,
  ownerPubkey,
  webUrl,
}: {
  channelId?: string | null;
  cloneUrl?: string;
  description?: string;
  name: string;
  ownerPubkey: string;
  webUrl?: string;
}): InitialProjectTemplates {
  const normalizedName = name.trim();
  if (!normalizedName) {
    throw new Error("Project name is required.");
  }
  if (byteLength(normalizedName) > MAX_PROJECT_NAME_BYTES) {
    throw new Error(
      `Project name must not exceed ${MAX_PROJECT_NAME_BYTES} bytes.`,
    );
  }
  const dtag = projectDtagFromName(normalizedName);
  if (!dtag) {
    throw new Error("Project name must include letters or numbers.");
  }
  const owner = ownerPubkey.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(owner)) {
    throw new Error("Project owner public key is invalid.");
  }
  const normalizedDescription = description?.trim() ?? "";
  if (byteLength(normalizedDescription) > MAX_PROJECT_DESCRIPTION_BYTES) {
    throw new Error(
      `Project description must not exceed ${MAX_PROJECT_DESCRIPTION_BYTES} bytes.`,
    );
  }

  const repositoryTags: string[][] = [
    ["d", dtag],
    ["name", normalizedName],
  ];
  const projectTags: string[][] = [
    ["d", dtag],
    ["name", normalizedName],
  ];
  const normalizedChannelId = channelId?.trim();
  if (normalizedChannelId) {
    if (!isValidProjectChannelId(normalizedChannelId)) {
      throw new Error("Project channel id is not a valid UUID.");
    }
    repositoryTags.push(["buzz-channel", normalizedChannelId]);
    projectTags.push(["buzz-channel", normalizedChannelId]);
  }
  if (normalizedDescription) {
    repositoryTags.push(["description", normalizedDescription]);
    projectTags.push(["description", normalizedDescription]);
  }
  const normalizedCloneUrl = cloneUrl?.trim();
  if (normalizedCloneUrl) {
    repositoryTags.push(["clone", normalizedCloneUrl]);
  }
  const normalizedWebUrl = webUrl?.trim();
  if (normalizedWebUrl) {
    repositoryTags.push(["web", normalizedWebUrl]);
  }

  const repositoryAddress = `${KIND_REPO_ANNOUNCEMENT}:${owner}:${dtag}`;
  projectTags.push(["a", repositoryAddress]);

  // Fail here rather than at the relay: the envelope checker is the same one
  // the read path runs, so anything it rejects would also be unrenderable.
  validateProjectEventEnvelope(projectTags, "");

  return {
    dtag,
    project: {
      kind: KIND_PROJECT_ANNOUNCEMENT,
      content: "",
      tags: projectTags,
    },
    repository: {
      kind: KIND_REPO_ANNOUNCEMENT,
      content: normalizedDescription,
      tags: repositoryTags,
    },
    repositoryAddress,
  };
}

/**
 * NIP-34 issue tags, in `build_git_issue` order. The repo owner is `p`-tagged
 * so the issue lands in their mention feed without a separate notification
 * path.
 */
export function buildGitIssueTags({
  labels = [],
  recipients = [],
  repoAddress,
  repoOwner,
  title,
}: {
  labels?: string[];
  recipients?: string[];
  repoAddress: string;
  repoOwner: string;
  title: string;
}): string[][] {
  if (!repoAddress.startsWith(`${KIND_REPO_ANNOUNCEMENT}:`)) {
    throw new Error(
      `Issue repo address must reference a kind:${KIND_REPO_ANNOUNCEMENT} repository.`,
    );
  }
  if (!isHex64(repoOwner)) {
    throw new Error("Repo owner must be 64 hex characters.");
  }
  const subject = title.trim();
  if (!subject) {
    throw new Error("Issue title is required.");
  }
  if (subject.length > MAX_ISSUE_SUBJECT_LENGTH) {
    throw new Error(
      `Issue title must be ${MAX_ISSUE_SUBJECT_LENGTH} characters or fewer.`,
    );
  }

  const tags: string[][] = [
    ["a", repoAddress],
    ["p", repoOwner.toLowerCase()],
  ];
  for (const recipient of recipients) {
    if (!isHex64(recipient)) {
      throw new Error("Issue recipient must be 64 hex characters.");
    }
    tags.push(["p", recipient.toLowerCase()]);
  }
  tags.push(["subject", subject]);
  for (const label of labels) {
    const trimmed = label.trim();
    if (trimmed) tags.push(["t", trimmed]);
  }
  return tags;
}

/** A complete kind:1621 template. `body` is markdown, rendered as-is on read. */
export function buildGitIssueTemplate(input: {
  body: string;
  labels?: string[];
  recipients?: string[];
  repoAddress: string;
  repoOwner: string;
  title: string;
}): EventTemplate {
  return {
    kind: KIND_GIT_ISSUE,
    content: input.body.trim(),
    tags: buildGitIssueTags(input),
  };
}

/**
 * NIP-34 status tags, in `build_git_status` order: the root marker first, then
 * recipients, then the repo coordinate that makes `#a` subscriptions work.
 */
export function buildGitStatusTags({
  recipients = [],
  repoAddress,
  rootEventId,
}: {
  recipients?: string[];
  repoAddress?: string | null;
  rootEventId: string;
}): string[][] {
  if (!isHex64(rootEventId)) {
    throw new Error("Issue id must be 64 hex characters.");
  }
  const tags: string[][] = [["e", rootEventId, "", "root"]];
  for (const recipient of new Set(
    recipients.filter(isHex64).map((value) => value.toLowerCase()),
  )) {
    tags.push(["p", recipient]);
  }
  if (repoAddress) tags.push(["a", repoAddress]);
  return tags;
}

/**
 * A lifecycle transition is a whole event, not a mutation: the kind carries
 * the new state and the `e` root tag says what moved. Publishing the state an
 * issue is already in is refused — it would be an event that changes nothing.
 */
export function buildIssueStatusTemplate({
  content = "",
  currentLifecycle,
  nextLifecycle,
  recipients = [],
  repoAddress,
  rootEventId,
}: {
  content?: string;
  currentLifecycle: IssueLifecycle | null;
  nextLifecycle: IssueLifecycle;
  recipients?: string[];
  repoAddress?: string | null;
  rootEventId: string;
}): EventTemplate {
  if (currentLifecycle === nextLifecycle) {
    throw new Error(`Issue is already ${nextLifecycle}.`);
  }
  return {
    kind: STATUS_KIND_BY_LIFECYCLE[nextLifecycle],
    content,
    tags: buildGitStatusTags({ recipients, repoAddress, rootEventId }),
  };
}

/**
 * An issue comment is a kind:1 note carrying the NIP-10 root marker, plus the
 * repo `a` tag so a single `#a` subscription picks up an issue's whole
 * conversation alongside its statuses.
 */
export function buildIssueCommentTemplate({
  body,
  recipients = [],
  repoAddress,
  rootEventId,
}: {
  body: string;
  recipients?: string[];
  repoAddress?: string | null;
  rootEventId: string;
}): EventTemplate {
  const content = body.trim();
  if (!content) {
    throw new Error("Comment cannot be empty.");
  }
  return {
    kind: KIND_TEXT_NOTE,
    content,
    tags: buildGitStatusTags({ recipients, repoAddress, rootEventId }),
  };
}
