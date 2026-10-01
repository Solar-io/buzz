/**
 * PR-merge asks (web redesign Phase 8): "a convention, not a new kind". A
 * decision card that references a NIP-34 pull request (kind 1618) is an
 * APPROVAL — the agent is asking for a merge, not for an opinion.
 *
 * The reference is the one the CLI already hands agents: `buzz pr open`
 * returns a `link` field, `buzz://pr?id=<event id>&owner=<pubkey>&d=<repo>`,
 * and the base prompt tells agents to include it verbatim whenever they
 * announce the PR. A `nostr:nevent1…` that names kind 1618 counts too. Plain
 * text is the only place a card can carry it today: the parsed card keeps no
 * tags, and the card JSON has no reference field.
 *
 * Read from the CARD's own text (title, body, each question and its body),
 * never from an option label: an option is the answer, not the subject.
 */

import { decode as nip19Decode } from "nostr-tools/nip19";

import type { DecisionCard } from "@/features/channels/lib/decisionCard.ts";

export const KIND_GIT_PULL_REQUEST = 1618;

export interface PrReference {
  /** The kind-1618 event id, lowercase hex. */
  eventId: string;
  /** Repository id (`d` of its 30617), when the link names it. */
  repo: string | null;
}

const BUZZ_PR = /buzz:\/\/pr\?([^\s<>()[\]"'`]+)/gi;
const NEVENT = /\bnostr:(nevent1[02-9ac-hj-np-z]+)/gi;
const HEX64 = /^[0-9a-f]{64}$/i;
const REPO_ID = /^[A-Za-z0-9._-]{1,128}$/;

function fromBuzzLink(query: string): PrReference | null {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(query.replace(/&amp;/g, "&"));
  } catch {
    return null;
  }
  const id = params.get("id") ?? "";
  if (!HEX64.test(id)) {
    return null;
  }
  const repo = params.get("d");
  return {
    eventId: id.toLowerCase(),
    repo: repo && REPO_ID.test(repo) ? repo : null,
  };
}

function fromNevent(bech: string): PrReference | null {
  try {
    const decoded = nip19Decode(bech);
    if (
      decoded.type === "nevent" &&
      decoded.data.kind === KIND_GIT_PULL_REQUEST
    ) {
      return { eventId: decoded.data.id.toLowerCase(), repo: null };
    }
  } catch {
    // Not a nevent this decoder can read: not a reference.
  }
  return null;
}

/** The first PR a text references, or null. */
export function prReferenceInText(text: string): PrReference | null {
  for (const match of text.matchAll(BUZZ_PR)) {
    const reference = fromBuzzLink(match[1]);
    if (reference) {
      return reference;
    }
  }
  for (const match of text.matchAll(NEVENT)) {
    const reference = fromNevent(match[1]);
    if (reference) {
      return reference;
    }
  }
  return null;
}

/** The PR a decision card asks about, or null when it is an ordinary ask. */
export function prReference(card: DecisionCard): PrReference | null {
  // A card restored from an older cache may lack `questions` (healCachedCard):
  // read it with `!= null`, never trust the declared type.
  const questions = card.questions != null ? card.questions : [];
  const texts = [
    card.title,
    card.body,
    ...questions.flatMap((question) => [question?.question, question?.body]),
  ];
  for (const text of texts) {
    if (typeof text === "string" && text !== "") {
      const reference = prReferenceInText(text);
      if (reference) {
        return reference;
      }
    }
  }
  return null;
}
