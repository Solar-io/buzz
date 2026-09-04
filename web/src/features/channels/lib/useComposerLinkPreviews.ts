/**
 * Composer-side link preview resolution.
 *
 * Watches the draft, asks the relay to unfurl each https link it finds, and
 * hands the composer the snapshot tags to attach on send.
 *
 * Three deliberate choices:
 *
 * 1. **Sending is never blocked.** A link that has not finished resolving when
 *    the author hits Enter simply sends as a plain link, which is what every
 *    client without this feature does and what the desktop renders anyway. The
 *    alternative — holding a message until a third party's server answers —
 *    makes an outside site able to delay Buzz.
 * 2. **Suppression is sticky per draft.** Dismissing the tray sends
 *    `["link-preview","none"]`, the marker the reader half already honours; it
 *    clears when the draft is cleared (i.e. after a send), not when the text
 *    changes, so a dismissal cannot be undone by typing another character.
 * 3. **Results are cached by href for the session.** Editing around a link
 *    must not re-fetch it, and the relay meters unfurls per pubkey.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { linkPreviewCandidates } from "./linkPreviewCandidates.ts";
import {
  buildSnapshotTag,
  selectSnapshotTags,
  type UnfurlResult,
} from "./linkPreviewSnapshot.ts";
import {
  fetchLinkPreviewCapability,
  unfurlLink,
  type LinkPreviewCapability,
} from "./relayLinkPreview.ts";

/** Idle time after the last keystroke before a link is resolved. */
const DEBOUNCE_MS = 450;

export interface ComposerPreviewCard {
  href: string;
  /** `resolving` until the relay answers; `none` when it had nothing. */
  state: "resolving" | "ready" | "none";
  title: string;
  site: string;
  /** Relay-hosted image URL, or "" — always this relay's own media origin. */
  imageUrl: string;
}

export interface ComposerLinkPreviews {
  /** Cards to render above the composer. Empty while suppressed. */
  cards: ComposerPreviewCard[];
  /** The author dismissed previews for this draft. */
  suppressed: boolean;
  /** Dismiss previews for this draft (emits the `none` marker on send). */
  suppress: () => void;
  /** Forget everything — call after a successful send. */
  reset: () => void;
  /**
   * Tags to attach to `content`. Keyed off the hrefs in the text being sent,
   * so a preview prepared for a since-deleted link cannot ride along.
   */
  tagsFor: (content: string) => string[][];
}

type Entry =
  | { status: "resolving" }
  | { status: "ready"; result: UnfurlResult; tag: string[] }
  | { status: "none" };

export function useComposerLinkPreviews(text: string): ComposerLinkPreviews {
  const [capability, setCapability] = useState<LinkPreviewCapability | null>(
    null,
  );
  const [entries, setEntries] = useState<ReadonlyMap<string, Entry>>(
    () => new Map(),
  );
  const [suppressed, setSuppressed] = useState(false);
  const [debounced, setDebounced] = useState("");
  // Mirrors `entries` for the resolver effect, so adding a result does not
  // re-trigger the effect that produced it.
  const entriesRef = useRef<ReadonlyMap<string, Entry>>(new Map());
  entriesRef.current = entries;

  useEffect(() => {
    const controller = new AbortController();
    fetchLinkPreviewCapability(controller.signal)
      .then((found) => {
        if (!controller.signal.aborted) {
          setCapability(found);
        }
      })
      .catch(() => {
        // An older or upstream relay has no unfurl route. The composer stays
        // exactly as it was before this feature existed.
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(text), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const candidates = useMemo(
    () => (capability && !suppressed ? linkPreviewCandidates(debounced) : []),
    [capability, debounced, suppressed],
  );
  // Stable across renders that produce the same links, so the resolver effect
  // does not re-run on every keystroke.
  const candidateKey = candidates.join("\n");

  useEffect(() => {
    if (!capability) {
      return;
    }
    const hrefs = candidateKey === "" ? [] : candidateKey.split("\n");
    const missing = hrefs.filter((href) => !entriesRef.current.has(href));
    if (missing.length === 0) {
      return;
    }
    const controller = new AbortController();
    setEntries((previous) => {
      const next = new Map(previous);
      for (const href of missing) {
        next.set(href, { status: "resolving" });
      }
      return next;
    });
    for (const href of missing) {
      unfurlLink(capability.unfurlPath, href, controller.signal)
        .then((result) => {
          if (controller.signal.aborted) {
            return;
          }
          const tag = result
            ? buildSnapshotTag(result, capability.mediaOrigin)
            : null;
          setEntries((previous) => {
            const next = new Map(previous);
            next.set(
              href,
              result && tag
                ? { status: "ready", result, tag }
                : { status: "none" },
            );
            return next;
          });
        })
        .catch(() => {
          if (controller.signal.aborted) {
            return;
          }
          // A refusal (rate limit, blocked URL, dead site) is not worth a
          // toast: the message still sends, with a plain link.
          setEntries((previous) => {
            const next = new Map(previous);
            next.set(href, { status: "none" });
            return next;
          });
        });
    }
    return () => controller.abort();
  }, [candidateKey, capability]);

  const cards = useMemo<ComposerPreviewCard[]>(() => {
    if (suppressed) {
      return [];
    }
    const out: ComposerPreviewCard[] = [];
    for (const href of candidates) {
      const entry = entries.get(href);
      if (!entry || entry.status === "none") {
        continue;
      }
      if (entry.status === "resolving") {
        out.push({
          href,
          state: "resolving",
          title: "",
          site: "",
          imageUrl: "",
        });
        continue;
      }
      out.push({
        href,
        state: "ready",
        title: entry.result.title,
        site: entry.result.site,
        imageUrl: entry.result.image?.url ?? "",
      });
    }
    return out;
  }, [candidates, entries, suppressed]);

  const tagsFor = useCallback(
    (content: string) => {
      if (!capability) {
        return [];
      }
      const tagsByHref = new Map<string, string[]>();
      for (const [href, entry] of entries) {
        if (entry.status === "ready") {
          tagsByHref.set(href, entry.tag);
        }
      }
      return selectSnapshotTags({
        content,
        liveHrefs: linkPreviewCandidates(content),
        suppressed,
        tagsByHref,
      });
    },
    [capability, entries, suppressed],
  );

  const reset = useCallback(() => {
    setSuppressed(false);
    setDebounced("");
  }, []);

  const suppress = useCallback(() => setSuppressed(true), []);

  return { cards, reset, suppress, suppressed, tagsFor };
}
