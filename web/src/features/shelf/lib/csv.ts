/**
 * Just enough RFC 4180 to preview a shared CSV/TSV as a table: quoted fields,
 * doubled quotes, separators and newlines inside quotes. Bounded — a preview
 * never needs the 200,001st row.
 *
 * Pure so `node --test` loads it directly.
 */

export interface ParsedTable {
  rows: string[][];
  /** More rows existed than were read. */
  truncated: boolean;
}

export function parseDelimited(
  text: string,
  separator: "," | "\t",
  maxRows = 500,
): ParsedTable {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let index = 0;
  const source = text.replace(/^﻿/, "");
  const endRow = () => {
    row.push(field);
    field = "";
    if (!(row.length === 1 && row[0] === "")) {
      rows.push(row);
    }
    row = [];
  };
  while (index < source.length) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"' && field === "") {
      quoted = true;
    } else if (char === separator) {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[index + 1] === "\n") {
        index += 1;
      }
      endRow();
      if (rows.length > maxRows) {
        return { rows: rows.slice(0, maxRows), truncated: true };
      }
    } else {
      field += char;
    }
    index += 1;
  }
  if (field !== "" || row.length > 0) {
    endRow();
  }
  return {
    rows: rows.slice(0, maxRows),
    truncated: rows.length > maxRows,
  };
}
