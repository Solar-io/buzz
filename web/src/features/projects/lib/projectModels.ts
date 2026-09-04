/**
 * NIP-MP / NIP-34 read models for the projects surface.
 *
 * The spec is `docs/nips/NIP-MP.md`; its two conformance oracles
 * (`NIP-MP.fixtures.json` for the ingest envelope, `NIP-MP.fold-fixtures.json`
 * for the client-side fold) are the authority this module is tested against,
 * not the shape this parser happens to produce. The relay's own validator is
 * `validate_project_envelope` in `crates/buzz-relay/src/handlers/ingest.rs`.
 *
 * A project (kind:30621) is a *pointer*, nothing more: it names member
 * repositories by `a` coordinate and grants its signer no authority over any
 * of them. Push policy reads the repository's own kind:30617 announcement, so
 * a stranger listing your repo changes nothing about your repo — which is why
 * the fold below only lets an *authorized* project (signed by the member's
 * owner or one of its `maintainers`) suppress that member's standalone card.
 */

import { KIND_PROJECT_ANNOUNCEMENT, KIND_REPO_ANNOUNCEMENT } from "./kinds.ts";

/** The subset of a signed Nostr event this module reads. */
export type ProjectSourceEvent = {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  content: string;
  tags: string[][];
};

export type Repository = {
  /** `<owner>:<dtag>` — stable within a community. */
  id: string;
  dtag: string;
  name: string;
  description: string;
  cloneUrls: string[];
  webUrl: string | null;
  owner: string;
  maintainers: string[];
  contributors: string[];
  createdAt: number;
  defaultBranch: string;
  /** `30617:<owner>:<dtag>` — the NIP-01 addressable coordinate. */
  repoAddress: string;
  /** NIP-29 channel bound to this repository, when the `buzz-channel` tag is a UUID. */
  channelId: string | null;
};

export type Project = {
  /** The project's addressable coordinate, or the repository's for an implicit card. */
  id: string;
  dtag: string;
  name: string;
  description: string;
  owner: string;
  createdAt: number;
  projectChannelId: string | null;
  projectAddress: string;
  /** Members that resolved to a live, viewer-visible repository head. */
  repositories: Repository[];
  /** Every member coordinate the event declared, sorted. */
  repositoryAddresses: string[];
  /** Optional per-member relay hints from the third `a` tag element. */
  repositoryRelayHints: Record<string, string>;
  /** Declared members that no live head answers — rendered as unavailable. */
  unavailableRepositoryAddresses: string[];
  visibility: "listed" | "unlisted";
  /**
   * True for an *implicit* card: a repository nobody authorized has claimed,
   * rendered as its own single-repository project so it does not vanish.
   */
  implicit: boolean;
};

/** NIP-MP rule `member-cap`: a project carries at most 64 member `a` tags. */
export const MAX_PROJECT_MEMBERS = 64;

/** Byte caps from `validate_project_envelope` (rule `metadata-length`). */
const MAX_METADATA_TAG_BYTES: Record<string, number> = {
  name: 256,
  description: 2_048,
  "buzz-channel": 256,
  "buzz-visibility": 256,
};

/** Rule `metadata-cardinality` applies to exactly these four tag names. */
const SINGLETON_METADATA_TAGS = [
  "name",
  "description",
  "buzz-channel",
  "buzz-visibility",
] as const;

const MAX_D_TAG_BYTES = 1_024;

const encoder = new TextEncoder();

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function getTag(event: ProjectSourceEvent, name: string): string | undefined {
  const value = event.tags.find((tag) => tag[0] === name)?.[1];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getAllTags(event: ProjectSourceEvent, name: string): string[] {
  return event.tags
    .filter(
      (tag) =>
        tag[0] === name && typeof tag[1] === "string" && tag[1].length > 0,
    )
    .map((tag) => tag[1]);
}

/** `maintainers` is a multi-value tag: every element after the name counts. */
function getAllTagValues(event: ProjectSourceEvent, name: string): string[] {
  return event.tags
    .filter((tag) => tag[0] === name)
    .flatMap((tag) => tag.slice(1))
    .filter((value) => value.length > 0);
}

function isHex64(value: string): boolean {
  return /^[a-fA-F0-9]{64}$/.test(value);
}

/**
 * NIP-MP rule `member-coordinate-malformed` requires a *lowercase* owner: `#a`
 * filter matching is byte-exact, so an uppercase coordinate would address a
 * repository no filter could ever resolve.
 */
function isLowercaseHex64(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function isValidDTag(value: string): boolean {
  return value.length > 0 && byteLength(value) <= MAX_D_TAG_BYTES;
}

/** RFC-4122 UUID, the shape a NIP-29 channel id takes. */
export function isValidProjectChannelId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

/**
 * Splits `30617:<lowercase-hex64>:<dtag>`. The `d` tag may itself contain
 * colons, so only the first two separators are structural.
 */
export function parseRepositoryAddress(
  value: string,
): { owner: string; dtag: string } | null {
  const firstSeparator = value.indexOf(":");
  if (firstSeparator < 0) return null;
  const secondSeparator = value.indexOf(":", firstSeparator + 1);
  if (
    secondSeparator < 0 ||
    value.slice(0, firstSeparator) !== String(KIND_REPO_ANNOUNCEMENT)
  ) {
    return null;
  }
  const owner = value.slice(firstSeparator + 1, secondSeparator);
  const dtag = value.slice(secondSeparator + 1);
  return isLowercaseHex64(owner) && isValidDTag(dtag) ? { owner, dtag } : null;
}

/** Thrown by {@link validateProjectEventEnvelope}; carries the NIP-MP rule id. */
export class ProjectEnvelopeError extends Error {
  readonly rule: string;

  constructor(rule: string, message: string) {
    super(`[${rule}] ${message}`);
    this.name = "ProjectEnvelopeError";
    this.rule = rule;
  }
}

/**
 * Validates the tag envelope of a kind:30621 event against the eight NIP-MP
 * rules the relay enforces at ingest. Shared by the read parser and the write
 * builder so this client cannot render a head it would refuse to publish, nor
 * publish one it would refuse to render.
 *
 * Rule-check order matches the relay's (`member-cap` before the per-tag work)
 * so a fixture asserting *which* rule fired agrees with the Rust.
 */
export function validateProjectEventEnvelope(
  tags: string[][],
  content: string,
): void {
  const dTags = tags.filter((tag) => tag[0] === "d");
  if (dTags.length !== 1) {
    throw new ProjectEnvelopeError(
      "d-cardinality",
      `project event must have exactly one \`d\` tag (got ${dTags.length})`,
    );
  }
  const dtag = dTags[0][1] ?? "";
  if (dtag.length === 0) {
    throw new ProjectEnvelopeError(
      "d-empty",
      "project event `d` tag must not be empty",
    );
  }
  if (byteLength(dtag) > MAX_D_TAG_BYTES) {
    throw new ProjectEnvelopeError(
      "d-empty",
      "project event `d` tag exceeds the maximum byte length",
    );
  }

  const memberTags = tags.filter((tag) => tag[0] === "a");
  if (memberTags.length > MAX_PROJECT_MEMBERS) {
    throw new ProjectEnvelopeError(
      "member-cap",
      `project event must have at most ${MAX_PROJECT_MEMBERS} member \`a\` tags (got ${memberTags.length})`,
    );
  }
  for (const tag of memberTags) {
    if (tag.length !== 2 && tag.length !== 3) {
      throw new ProjectEnvelopeError(
        "member-tag-arity",
        `project event member \`a\` tag must have exactly 2 or 3 elements (got ${tag.length})`,
      );
    }
  }
  const seen = new Set<string>();
  for (const tag of memberTags) {
    const address = tag[1] ?? "";
    if (!parseRepositoryAddress(address)) {
      throw new ProjectEnvelopeError(
        "member-coordinate-malformed",
        `project event member coordinate ${JSON.stringify(address)} is not \`30617:<lowercase-hex64>:<dtag>\``,
      );
    }
    if (seen.has(address)) {
      throw new ProjectEnvelopeError(
        "member-duplicate",
        `project event has duplicate member coordinate ${JSON.stringify(address)}`,
      );
    }
    seen.add(address);
  }

  for (const tagName of SINGLETON_METADATA_TAGS) {
    const count = tags.filter((tag) => tag[0] === tagName).length;
    if (count > 1) {
      throw new ProjectEnvelopeError(
        "metadata-cardinality",
        `project event must have at most one \`${tagName}\` tag (got ${count})`,
      );
    }
  }
  for (const tagName of SINGLETON_METADATA_TAGS) {
    const value = tags.find((tag) => tag[0] === tagName)?.[1];
    const maxBytes = MAX_METADATA_TAG_BYTES[tagName];
    if (value !== undefined && byteLength(value) > maxBytes) {
      throw new ProjectEnvelopeError(
        "metadata-length",
        `project event \`${tagName}\` tag too long (${byteLength(value)} bytes, max ${maxBytes})`,
      );
    }
  }

  // Content is preserved verbatim; NIP-MP places no constraint on it.
  void content;
}

/**
 * Canonical relay-hosted clone URL for an announcement with no `clone` tag.
 * Buzz relays serve git at `<origin>/git/<owner>/<repo-id>`; without this a
 * repo created by `buzz repos create` (no `--clone`) has nothing to clone.
 * Fails closed rather than emitting a broken URL.
 */
export function deriveRelayCloneUrl(
  relayOrigin: string | null | undefined,
  owner: string,
  dtag: string,
): string | null {
  if (!relayOrigin || !owner || !dtag) return null;
  if (!isHex64(owner)) return null;
  return `${relayOrigin.replace(/\/+$/, "")}/git/${owner.toLowerCase()}/${dtag}`;
}

/** Explicit `clone` tags always win — NIP-34 permits pointing them off-relay. */
export function effectiveCloneUrls(
  cloneUrls: string[],
  relayOrigin: string | null | undefined,
  owner: string,
  dtag: string,
): string[] {
  if (cloneUrls.length > 0) return cloneUrls;
  const derived = deriveRelayCloneUrl(relayOrigin, owner, dtag);
  return derived ? [derived] : [];
}

/** Parses a kind:30617 announcement, or null when it is not addressable. */
export function eventToRepository(
  event: ProjectSourceEvent,
  relayOrigin?: string | null,
): Repository | null {
  const dtag = getTag(event, "d");
  if (
    event.kind !== KIND_REPO_ANNOUNCEMENT ||
    !dtag ||
    !isValidDTag(dtag) ||
    !isHex64(event.pubkey)
  ) {
    return null;
  }
  const owner = event.pubkey.toLowerCase();
  const channel = getTag(event, "buzz-channel");
  const cloneTag = event.tags.find((tag) => tag[0] === "clone");
  return {
    id: `${owner}:${dtag}`,
    dtag,
    name: getTag(event, "name") ?? dtag,
    description: getTag(event, "description") ?? event.content ?? "",
    cloneUrls: effectiveCloneUrls(
      cloneTag?.slice(1).filter((value) => value.length > 0) ?? [],
      relayOrigin,
      owner,
      dtag,
    ),
    webUrl: getTag(event, "web") ?? null,
    owner,
    maintainers: getAllTagValues(event, "maintainers")
      .map((value) => value.toLowerCase())
      .filter(isHex64),
    contributors: [
      ...new Set([...getAllTags(event, "p"), ...getAllTags(event, "auth")]),
    ],
    createdAt: event.created_at,
    defaultBranch: getTag(event, "default-branch") ?? "main",
    repoAddress: `${KIND_REPO_ANNOUNCEMENT}:${owner}:${dtag}`,
    channelId: channel && isValidProjectChannelId(channel) ? channel : null,
  };
}

/**
 * Parses a kind:30621 project head. Returns null for an envelope the relay
 * would have rejected — a client that renders what ingest refuses would show
 * state no other client can see.
 */
export function eventToProject(
  event: ProjectSourceEvent,
  liveRepositories: ReadonlyMap<string, Repository>,
  visibleRepositories: ReadonlyMap<string, Repository>,
): Project | null {
  if (event.kind !== KIND_PROJECT_ANNOUNCEMENT || !isHex64(event.pubkey)) {
    return null;
  }
  try {
    validateProjectEventEnvelope(event.tags, event.content);
  } catch {
    return null;
  }

  const dtag = event.tags.find((tag) => tag[0] === "d")?.[1] ?? "";
  const repositoryAddresses: string[] = [];
  const repositoryRelayHints: Record<string, string> = {};
  for (const tag of event.tags.filter((candidate) => candidate[0] === "a")) {
    const address = tag[1];
    repositoryAddresses.push(address);
    if (tag[2]) repositoryRelayHints[address] = tag[2];
  }
  repositoryAddresses.sort();

  const owner = event.pubkey.toLowerCase();
  const visibility =
    getTag(event, "buzz-visibility") === "unlisted" ? "unlisted" : "listed";
  const channel = getTag(event, "buzz-channel");
  return {
    id: `${KIND_PROJECT_ANNOUNCEMENT}:${owner}:${dtag}`,
    dtag,
    name: getTag(event, "name") ?? dtag,
    description: getTag(event, "description") ?? "",
    owner,
    createdAt: event.created_at,
    projectChannelId:
      channel && isValidProjectChannelId(channel) ? channel : null,
    projectAddress: `${KIND_PROJECT_ANNOUNCEMENT}:${owner}:${dtag}`,
    repositories: repositoryAddresses.flatMap((address) => {
      const repository = visibleRepositories.get(address);
      return repository ? [repository] : [];
    }),
    repositoryAddresses,
    repositoryRelayHints,
    // A viewer-hidden member is absent everywhere, not "unavailable": hiding a
    // repository is the viewer's decision and someone else's grouping must not
    // undo it. Only a coordinate with no live head at all is unavailable.
    unavailableRepositoryAddresses: repositoryAddresses.filter(
      (address) => !liveRepositories.has(address),
    ),
    visibility,
    implicit: false,
  };
}

/** A repository nobody authorized has claimed renders as its own card. */
function repositoryToImplicitProject(repository: Repository): Project {
  return {
    id: repository.repoAddress,
    dtag: repository.dtag,
    name: repository.name,
    description: repository.description,
    owner: repository.owner,
    createdAt: repository.createdAt,
    projectChannelId: repository.channelId,
    projectAddress: repository.repoAddress,
    repositories: [repository],
    repositoryAddresses: [repository.repoAddress],
    repositoryRelayHints: {},
    unavailableRepositoryAddresses: [],
    visibility: "listed",
    implicit: true,
  };
}

/**
 * NIP-33 head selection: latest `created_at` wins, ties broken by the lower
 * event id so every client picks the same head.
 */
export function deduplicateAddressableEvents(
  events: ProjectSourceEvent[],
): ProjectSourceEvent[] {
  const latest = new Map<string, ProjectSourceEvent>();
  for (const event of events) {
    const dtag = event.tags.find((tag) => tag[0] === "d")?.[1];
    if (!dtag) continue;
    const key = `${event.kind}:${event.pubkey.toLowerCase()}:${dtag}`;
    const current = latest.get(key);
    if (
      !current ||
      event.created_at > current.created_at ||
      (event.created_at === current.created_at && event.id < current.id)
    ) {
      latest.set(key, event);
    }
  }
  return [...latest.values()];
}

/**
 * NIP-09 deletion thresholds by coordinate. A deletion counts only when its
 * signer owns the coordinate it names, and it buries only heads at or before
 * its own `created_at` — a later republish resurrects the address.
 */
function buildDeletionThresholds(
  deletionEvents: ProjectSourceEvent[],
): Map<string, number> {
  const thresholds = new Map<string, number>();
  for (const event of deletionEvents) {
    const signer = event.pubkey.toLowerCase();
    for (const tag of event.tags) {
      if (tag[0] !== "a" || !tag[1]) continue;
      const coordinate = tag[1];
      const firstColon = coordinate.indexOf(":");
      const secondColon = coordinate.indexOf(":", firstColon + 1);
      if (firstColon < 0 || secondColon < 0) continue;
      if (
        coordinate.slice(firstColon + 1, secondColon).toLowerCase() !== signer
      ) {
        continue;
      }
      const existing = thresholds.get(coordinate);
      if (existing === undefined || event.created_at > existing) {
        thresholds.set(coordinate, event.created_at);
      }
    }
  }
  return thresholds;
}

export type BuildProjectReadModelsInput = {
  projectEvents: ProjectSourceEvent[];
  repositoryEvents: ProjectSourceEvent[];
  /** kind:5 deletion events naming project or repository coordinates. */
  deletionEvents?: ProjectSourceEvent[];
  relayOrigin?: string | null;
  /** Coordinates this viewer has hidden locally. */
  hiddenAddresses?: ReadonlySet<string>;
};

/**
 * The NIP-MP fold — the four steps of `docs/nips/NIP-MP.md`:
 *
 * 1. Resolve every project and repository head (NIP-33 replacement, NIP-09
 *    deletion).
 * 2. Render each listing-eligible project as a container, its members
 *    resolved or explicitly unavailable.
 * 3. Suppress a repository's own card when *at least one* rendered project
 *    that is authorized for it (signed by its owner or one of its
 *    `maintainers`) lists it. "At least one" is the discriminating rule: an
 *    unauthorized project renders the member but never claims it.
 * 4. Everything else falls back to an implicit single-repository card.
 *
 * Newest first, so a freshly created project is the first thing on screen.
 */
export function buildProjectReadModels({
  projectEvents,
  repositoryEvents,
  deletionEvents = [],
  relayOrigin,
  hiddenAddresses = new Set<string>(),
}: BuildProjectReadModelsInput): Project[] {
  const thresholds = buildDeletionThresholds(deletionEvents);
  const isDeleted = (event: ProjectSourceEvent): boolean => {
    const dtag = event.tags.find((tag) => tag[0] === "d")?.[1];
    if (!dtag) return false;
    const threshold = thresholds.get(
      `${event.kind}:${event.pubkey.toLowerCase()}:${dtag}`,
    );
    return threshold !== undefined && event.created_at <= threshold;
  };

  const repositories = deduplicateAddressableEvents(repositoryEvents)
    .filter((event) => !isDeleted(event))
    .flatMap((event) => {
      const repository = eventToRepository(event, relayOrigin);
      return repository ? [repository] : [];
    });
  const liveRepositories = new Map(
    repositories.map((repository) => [repository.repoAddress, repository]),
  );
  const visibleRepositories = new Map(
    repositories
      .filter((repository) => !hiddenAddresses.has(repository.repoAddress))
      .map((repository) => [repository.repoAddress, repository]),
  );

  const containers = deduplicateAddressableEvents(projectEvents)
    .filter((event) => !isDeleted(event))
    .flatMap((event) => {
      const project = eventToProject(
        event,
        liveRepositories,
        visibleRepositories,
      );
      return project &&
        project.visibility === "listed" &&
        !hiddenAddresses.has(project.projectAddress)
        ? [project]
        : [];
    });

  const claimed = new Set(
    containers.flatMap((project) =>
      project.repositoryAddresses.filter((address) => {
        const repository = liveRepositories.get(address);
        return (
          repository !== undefined &&
          (repository.owner === project.owner ||
            repository.maintainers.includes(project.owner))
        );
      }),
    ),
  );

  const implicitCards = [...visibleRepositories.values()]
    .filter((repository) => !claimed.has(repository.repoAddress))
    .map(repositoryToImplicitProject);

  return [...containers, ...implicitCards].sort(
    (left, right) =>
      right.createdAt - left.createdAt || left.id.localeCompare(right.id),
  );
}

/** The repository a detail view should open on, honouring an explicit request. */
export function selectProjectRepository(
  project: Project | null | undefined,
  requestedRepositoryId?: string | null,
): Repository | null {
  if (!project) return null;
  const requested = requestedRepositoryId
    ? project.repositories.find(
        (repository) => repository.id === requestedRepositoryId,
      )
    : null;
  if (requested) return requested;
  return (
    project.repositories.find(
      (repository) => repository.dtag === project.dtag,
    ) ??
    project.repositories[0] ??
    null
  );
}
