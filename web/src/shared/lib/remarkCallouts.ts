/**
 * Remark plugin: GitHub-style callouts (web redesign Phase 2).
 *
 *   > [!NOTE]
 *   > All four reach the title screen. Zero JS errors.
 *
 *   > [!WARNING] Not tested
 *   > Audio, and whether the AI launches attack waves.
 *
 * A blockquote whose first line is one of the five markers becomes a custom
 * `<callout>` element (rendered by MarkdownContent). Anything else — an
 * unknown marker, a marker that is not first — stays an ordinary quote, so a
 * message quoting `[!FOO]` literally still reads as written.
 *
 * Text after the marker on the same line is the callout's TITLE when a body
 * follows it; on a one-line callout it is the body, under the default title.
 * (GitHub has no custom titles; the fleet uses them — "Tested in Agent
 * Brave" says more than "Note" — and GitHub degrades them to body text.)
 *
 * Import-free, like remarkSpoilers, so `node --test` loads it directly.
 */

type Node = {
  // biome-ignore lint/suspicious/noExplicitAny: building mdast-compatible nodes
  [key: string]: any;
};

export const CALLOUT_TYPES = [
  "note",
  "tip",
  "important",
  "warning",
  "caution",
] as const;
export type CalloutType = (typeof CALLOUT_TYPES)[number];

const MARKER = /^\[!([A-Za-z]+)\][ \t]*/;

export default function remarkCallouts() {
  return (
    // biome-ignore lint/suspicious/noExplicitAny: remark tree types are not available
    tree: any,
  ) => {
    transform(tree);
  };
}

function transform(node: Node) {
  if (!node || !Array.isArray(node.children)) {
    return;
  }
  for (const child of node.children) {
    transform(child);
  }
  node.children = node.children.map((child: Node) =>
    child.type === "blockquote" ? (toCallout(child) ?? child) : child,
  );
}

function toCallout(quote: Node): Node | null {
  const first = quote.children?.[0];
  if (first?.type !== "paragraph" || !Array.isArray(first.children)) {
    return null;
  }
  const lead = first.children[0];
  if (lead?.type !== "text") {
    return null;
  }
  const value = String(lead.value ?? "");
  const match = MARKER.exec(value);
  if (!match) {
    return null;
  }
  const type = match[1].toLowerCase();
  if (!(CALLOUT_TYPES as readonly string[]).includes(type)) {
    return null;
  }

  const afterMarker = value.slice(match[0].length);
  const newline = afterMarker.indexOf("\n");
  const moreInline = first.children.length > 1;
  const moreBlocks = quote.children.length > 1;

  let title = "";
  let rest: string;
  if (newline !== -1) {
    // "[!NOTE] Title\nbody…" — the first line is the title.
    title = afterMarker.slice(0, newline).trim();
    rest = afterMarker.slice(newline + 1);
  } else if (!moreInline && moreBlocks) {
    // The marker line stands alone and further blocks are the body.
    title = afterMarker.trim();
    rest = "";
  } else {
    // A one-line callout: the text is the body, not a title.
    rest = afterMarker;
  }

  const paragraphChildren =
    rest === ""
      ? first.children.slice(1)
      : [{ ...lead, value: rest }, ...first.children.slice(1)];
  const body =
    paragraphChildren.length > 0
      ? [{ ...first, children: paragraphChildren }, ...quote.children.slice(1)]
      : quote.children.slice(1);

  return {
    type: "callout",
    children: body,
    data: {
      hName: "callout",
      hProperties: {
        "data-callout": type,
        ...(title ? { "data-title": title } : {}),
      },
    },
  };
}
