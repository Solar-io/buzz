/**
 * Which columns of a markdown table hold numbers (web redesign Phase 2).
 *
 * The table card right-aligns numeric columns so digits line up and a column
 * of sizes or durations can be compared by eye (Message artboard: "32 min",
 * "92 KB"). Markdown gives the author `---:` for that, and an explicit
 * alignment always wins; this is the default for the tables agents actually
 * write, which almost never carry one.
 *
 * A column is numeric when every non-empty body cell is a number — optionally
 * signed, with a currency prefix, thousands separators, a decimal part and a
 * short unit ("32 min", "$3.50", "1,204", "12%", "1.6×") — and at least one
 * cell is. One word in the column ("n/a" counts as empty, "fast" does not)
 * and it stays left-aligned: a half-right-aligned column reads as a bug.
 *
 * Pure and import-free so `node --test` loads it directly.
 */

const NUMBER =
  /^[-+−]?[$€£]?\d[\d,]*(?:\.\d+)?\s?(?:%|×|x|[a-zA-Zµ]{1,5}(?:\/[a-zA-Z]{1,5})?)?$/;

/** Cells that carry no value: they neither make nor break a numeric column. */
const EMPTY = /^(?:|-|–|—|n\/a|na|none)$/i;

export function isNumericCell(text: string): boolean {
  return NUMBER.test(text.trim());
}

/**
 * One flag per column. `rows` are the BODY rows only (the header is a label,
 * not data); ragged rows are read as far as they go.
 */
export function numericColumns(
  rows: readonly (readonly string[])[],
): boolean[] {
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const flags: boolean[] = [];
  for (let column = 0; column < width; column += 1) {
    let numbers = 0;
    let words = 0;
    for (const row of rows) {
      const cell = (row[column] ?? "").trim();
      if (EMPTY.test(cell)) {
        continue;
      }
      if (isNumericCell(cell)) {
        numbers += 1;
      } else {
        words += 1;
      }
    }
    flags.push(numbers > 0 && words === 0);
  }
  return flags;
}
