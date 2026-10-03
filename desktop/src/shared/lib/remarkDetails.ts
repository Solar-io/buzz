/**
 * Remark plugin for agent-authored <details><summary>…</summary> blocks.
 * Only these two tags and the boolean `open` attribute become elements;
 * other HTML remains an html node, escaped by react-markdown as usual.
 */

type Node = {
  type: string;
  value?: string;
  children?: Node[];
  data?: {
    hName?: string;
    hProperties?: { open?: boolean };
  };
};

type Parser = { parse: (value: string) => Node };

const OPEN =
  /^\s*<details(?:\s+(open))?\s*>\s*<summary\s*>([\s\S]*?)<\/summary\s*>/i;
const CLOSE = /^\s*<\/details\s*>/i;

/** Run before other remark transforms so re-parsed bodies receive spoilers,
 * mentions, callouts, hard breaks, etc. through the normal renderer stack. */
export default function remarkDetails(this: Parser) {
  return (tree: Node) => transform(tree, (value) => this.parse(value));
}

function transform(parent: Node, parse: Parser["parse"]) {
  if (
    !parent.children ||
    parent.type === "code" ||
    parent.type === "inlineCode"
  ) {
    return;
  }
  // Block elements belong in flow containers, never inside a paragraph,
  // link, table cell or another phrasing node.
  if (!["root", "blockquote", "listItem"].includes(parent.type)) {
    for (const child of parent.children) transform(child, parse);
    return;
  }

  const output: Node[] = [];
  const stack: Node[][] = [output];
  const pending = [...parent.children].reverse();
  const enqueue = (value: string) => {
    // Use the owning processor's parser, including its GFM extensions. Only
    // parse here: downstream transforms must run once on the completed tree.
    if (value.trim()) pending.push(...(parse(value).children ?? []).reverse());
  };

  while (pending.length > 0) {
    const child = pending.pop();
    if (!child) break;
    let value = child.type === "html" ? (child.value ?? "") : "";
    // A blank line between the tags can put the summary in a second html node.
    if (/^\s*<details(?:\s+open)?\s*>\s*$/i.test(value)) {
      const next = pending[pending.length - 1];
      if (next?.type === "html" && OPEN.test(`${value}\n${next.value}`)) {
        value += `\n${next.value}`;
        pending.pop();
      }
    }

    const opening = OPEN.exec(value);
    if (opening) {
      const label = parse(opening[2]);
      const children: Node[] = [
        {
          type: "summary",
          children:
            label.children?.length === 1 &&
            label.children[0].type === "paragraph"
              ? label.children[0].children
              : [{ type: "text", value: opening[2] }],
          data: { hName: "summary" },
        },
      ];
      stack[stack.length - 1].push({
        type: "details",
        children,
        data: {
          hName: "details",
          ...(opening[1] ? { hProperties: { open: true } } : {}),
        },
      });
      stack.push(children);
      enqueue(value.slice(opening[0].length));
      continue;
    }

    const closing = CLOSE.exec(value);
    if (closing && stack.length > 1) {
      stack.pop();
      enqueue(value.slice(closing[0].length));
      continue;
    }

    // Re-parsing the body exposes code nodes before any tag recognition.
    // A literal </details> inside a fence therefore cannot close the block.
    transform(child, parse);
    stack[stack.length - 1].push(child);
  }
  // An unclosed block intentionally owns the rest of this container only.
  parent.children = output;
}
