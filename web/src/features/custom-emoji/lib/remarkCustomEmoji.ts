/**
 * Remark plugin: replace known `:shortcode:` runs in message text with a
 * custom `emoji` element that react-markdown renders as an inline image.
 *
 * Only shortcodes present in the supplied palette match — an unknown `:foo:`
 * stays literal text, which is the NIP-30 fallback and also what stops the
 * plugin from mangling ordinary prose (`ratio 3:2:1`, `http://` is inside a
 * link node and skipped anyway).
 *
 * Wiring, for whoever owns `features/channels/ui/MarkdownContent.tsx`:
 *
 *   remarkPlugins={[remarkGfm, remarkSpoilers, [remarkCustomEmoji, { palette }]]}
 *
 * plus one renderer entry alongside the existing `spoiler` cast:
 *
 *   emoji: ({ src, alt, "data-shortcode": shortcode }) => (
 *     <CustomEmojiImage shortcode={shortcode} url={src} />
 *   )
 *
 * Without that renderer entry react-markdown drops the unknown `emoji` tag and
 * the shortcode vanishes from the message — worse than leaving it literal —
 * so the two changes belong in one commit.
 */

import { buildShortcodePattern, splitShortcodes } from "./shortcodeParts.ts";
import { emojiUrlMap, type CustomEmoji } from "./customEmoji.ts";

export interface RemarkCustomEmojiOptions {
  palette?: ReadonlyArray<CustomEmoji>;
}

/** mdast/hast nodes are structurally typed here; the tree types are untyped. */
// biome-ignore lint/suspicious/noExplicitAny: building mdast-compatible nodes
type Node = { [key: string]: any };

export default function remarkCustomEmoji(options?: RemarkCustomEmojiOptions) {
  const palette = options?.palette ?? [];
  const urlByShortcode = emojiUrlMap(palette);
  const pattern = buildShortcodePattern([...urlByShortcode.keys()]);

  return (tree: Node) => {
    if (!pattern) {
      return;
    }
    walk(tree, pattern, urlByShortcode);
  };
}

/** Nodes whose text is not prose and must never be rewritten. */
function shouldSkip(node: Node): boolean {
  return (
    node.type === "link" || node.type === "code" || node.type === "inlineCode"
  );
}

function walk(
  node: Node,
  pattern: RegExp,
  urlByShortcode: ReadonlyMap<string, string>,
): void {
  if (!Array.isArray(node?.children) || shouldSkip(node)) {
    return;
  }
  // Backwards, so a splice never shifts an index still to be visited. A
  // forwards loop that re-reads `children.length` also happens to be correct
  // here (a mutation to forwards leaves the tests green) — this direction is
  // the one that stays correct without depending on that.
  for (let index = node.children.length - 1; index >= 0; index -= 1) {
    const child = node.children[index] as Node;
    if (child.type !== "text") {
      walk(child, pattern, urlByShortcode);
      continue;
    }
    const parts = splitShortcodes(child.value, urlByShortcode, pattern);
    if (parts.length === 1 && parts[0].kind === "text") {
      continue;
    }
    node.children.splice(
      index,
      1,
      ...parts.map((part) =>
        part.kind === "emoji"
          ? emojiNode(part.shortcode, part.url)
          : { type: "text", value: part.value },
      ),
    );
  }
}

/**
 * The replacement node. `hName`/`hProperties` are the mdast-to-hast escape
 * hatch: they make react-markdown emit `<emoji src alt data-shortcode>`, which
 * the components map turns into a real image.
 */
export function emojiNode(shortcode: string, url: string): Node {
  return {
    type: "emoji",
    value: `:${shortcode}:`,
    data: {
      hName: "emoji",
      hProperties: {
        src: url,
        alt: `:${shortcode}:`,
        "data-shortcode": shortcode,
      },
    },
  };
}
