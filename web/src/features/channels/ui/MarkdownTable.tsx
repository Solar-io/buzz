import {
  Children,
  cloneElement,
  createContext,
  type CSSProperties,
  isValidElement,
  type ReactNode,
  useContext,
  useMemo,
} from "react";
import { cn } from "@/shared/lib/cn";
import { numericColumns } from "../lib/markdownTable.ts";

/**
 * A markdown table as a card (web redesign Phase 2; Message artboard): a
 * bordered surface of its own, a sunk header row of small caps, and numeric
 * columns right-aligned in the mono face so figures line up.
 *
 * The four pieces are react-markdown renderers (`table`, `tr`, `th`, `td`).
 * Which columns are numeric is decided once per table from its body cells
 * (`numericColumns`) and reaches each cell through context; the row tells
 * each cell its column by cloning — react-markdown hands a cell no index.
 * An explicit markdown alignment (`:---:`) always wins over the default.
 *
 * A wide table scrolls INSIDE its card. On a phone the alternative is a
 * message that pushes the whole timeline sideways.
 */

/** The slice of a hast node these renderers read. */
interface HastNode {
  type?: string;
  tagName?: string;
  value?: string;
  children?: HastNode[];
}

const NumericColumns = createContext<readonly boolean[]>([]);

function textOf(node: HastNode): string {
  if (node.type === "text") {
    return node.value ?? "";
  }
  return (node.children ?? []).map(textOf).join("");
}

function elements(node: HastNode | undefined, tagName: string): HastNode[] {
  return (node?.children ?? []).filter(
    (child) => child.type === "element" && child.tagName === tagName,
  );
}

/** The body rows' cell text, for the numeric-column decision. */
export function tableBodyText(table: HastNode | undefined): string[][] {
  return elements(table, "tbody").flatMap((body) =>
    elements(body, "tr").map((row) => elements(row, "td").map(textOf)),
  );
}

export function MarkdownTable({
  node,
  children,
}: {
  node?: HastNode;
  children?: ReactNode;
}) {
  const numeric = useMemo(() => numericColumns(tableBodyText(node)), [node]);
  return (
    <NumericColumns.Provider value={numeric}>
      <div
        data-testid="markdown-table"
        // not-prose: the card styles every cell itself, and typography's
        // table margins (26px) out-rank a my-0 on the table.
        className="not-prose my-2 max-w-full overflow-hidden rounded-xl border border-border bg-card"
      >
        <div className="buzz-content-scrollbar overflow-x-auto">
          <table className="my-0 w-full border-collapse text-left text-sidebar-meta [&_thead_tr]:bg-sunk">
            {children}
          </table>
        </div>
      </div>
    </NumericColumns.Provider>
  );
}

export function MarkdownTableRow({ children }: { children?: ReactNode }) {
  let column = 0;
  return (
    <tr className="border-b border-border last:border-b-0">
      {Children.map(children, (child) => {
        if (!isValidElement(child)) {
          return child;
        }
        const next = cloneElement(child, { "data-col": column } as object);
        column += 1;
        return next;
      })}
    </tr>
  );
}

function cell(header: boolean) {
  return function MarkdownTableCell({
    children,
    style,
    align,
    "data-col": column,
  }: {
    children?: ReactNode;
    style?: CSSProperties;
    align?: string;
    "data-col"?: number;
  }) {
    const numeric = useContext(NumericColumns)[column ?? -1] === true;
    const explicit =
      (style?.textAlign as CSSProperties["textAlign"] | undefined) ??
      (align as CSSProperties["textAlign"] | undefined);
    const textAlign = explicit ?? (numeric ? "right" : undefined);
    const Tag = header ? "th" : "td";
    return (
      <Tag
        style={textAlign ? { textAlign } : undefined}
        data-numeric={numeric ? "true" : undefined}
        className={cn(
          "border-0 px-3.5 align-middle",
          header
            ? "h-9 whitespace-nowrap py-0 text-2xs font-semibold uppercase tracking-[0.06em] text-muted-foreground"
            : "py-2.5",
          !header &&
            numeric &&
            "whitespace-nowrap font-mono text-xs tabular-nums",
        )}
      >
        {children}
      </Tag>
    );
  };
}

export const MarkdownTableHeaderCell = cell(true);
export const MarkdownTableDataCell = cell(false);
