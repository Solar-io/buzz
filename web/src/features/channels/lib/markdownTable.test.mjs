import assert from "node:assert/strict";
import test from "node:test";

import { isNumericCell, numericColumns } from "./markdownTable.ts";

test("numbers with signs, currency, separators and short units are numeric", () => {
  for (const cell of [
    "5",
    "4.83",
    "-3",
    "−3",
    "+12",
    "1,204",
    "$3.50",
    "12%",
    "32 min",
    "92 KB",
    "219KB",
    "1.6×",
    "2x",
    "40 req/s",
    " 7 ",
  ]) {
    assert.equal(isNumericCell(cell), true, cell);
  }
  for (const cell of [
    "",
    "Sol max",
    "v2",
    "2026-09-30",
    "3:24 PM",
    "5 of 6",
    "fast",
    "C",
    "1.2.3",
    "12 kilobytes!",
  ]) {
    assert.equal(isNumericCell(cell), false, cell);
  }
});

test("numeric columns right-align; a mixed column does not", () => {
  // The Message artboard's table: Game | Model | Your score | Build | Size.
  const rows = [
    ["C", "Sol max", "5", "32 min", "92 KB"],
    ["D", "Opus xhigh", "4", "56 min", "219 KB"],
    ["B", "Opus high", "2", "31 min", "164 KB"],
    ["A", "Sol high", "1", "28 min", "41 KB"],
  ];
  assert.deepEqual(numericColumns(rows), [false, false, true, true, true]);

  // One word in a column of numbers keeps the whole column left-aligned.
  assert.deepEqual(
    numericColumns([
      ["a", "12"],
      ["b", "fast"],
      ["c", "9"],
    ]),
    [false, false],
  );
});

test("empty cells are neutral, but an all-empty column is not numeric", () => {
  assert.deepEqual(
    numericColumns([
      ["x", "12", "—"],
      ["y", "n/a", ""],
      ["z", "7", "-"],
    ]),
    [false, true, false],
  );
  // Ragged rows are read as far as they go.
  assert.deepEqual(numericColumns([["a", "1"], ["b"]]), [false, true]);
  assert.deepEqual(numericColumns([]), []);
});
