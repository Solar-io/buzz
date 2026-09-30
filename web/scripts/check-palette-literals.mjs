import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Ratchet on Tailwind colour LITERALS (web redesign Phase 0, phase-0.md §6).
 *
 * The redesign's fixed palettes (buzz-light / buzz-dark) and every derived
 * theme paint through semantic tokens (`bg-work`, `text-need`, `bg-sunk`, …).
 * A stock-palette literal (`text-amber-600`, `bg-emerald-500`) or an arbitrary
 * hex (`bg-[#F3F3F3]`) ignores the theme, so the palette decays with every new
 * one. Existing literals are grandfathered per file in
 * `palette-literals-baseline.json`; a file may only go DOWN. Phase 1 migrates
 * the surfaces it redesigns and lowers the baseline with `--update`.
 *
 *   node scripts/check-palette-literals.mjs           # check
 *   node scripts/check-palette-literals.mjs --update  # rewrite the baseline
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const baselinePath = path.join(__dirname, "palette-literals-baseline.json");

const HUES =
  "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const UTILITIES =
  "bg|text|border(?:-[xytrbl])?|ring(?:-offset)?|outline|divide|fill|stroke|from|via|to|decoration|shadow|accent|caret|placeholder";
// `(?<![\w-])` keeps `hover:bg-…` (a variant) but not `foo-bg-…`.
export const LITERAL = new RegExp(
  `(?<![\\w-])(?:${UTILITIES})-(?:(?:${HUES})-\\d{2,3}|\\[#[0-9a-fA-F]{3,8}\\])`,
  "g",
);

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function currentCounts() {
  const counts = {};
  for (const file of sourceFiles(path.join(projectRoot, "src")).sort()) {
    const matches = readFileSync(file, "utf8").match(LITERAL);
    if (matches) {
      counts[path.relative(projectRoot, file)] = matches.length;
    }
  }
  return counts;
}

const counts = currentCounts();
if (process.argv.includes("--update")) {
  writeFileSync(baselinePath, `${JSON.stringify(counts, null, 2)}\n`);
  console.log(
    `Palette literals: baseline written (${Object.keys(counts).length} files).`,
  );
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const grown = Object.entries(counts).filter(
  ([file, count]) => count > (baseline[file] ?? 0),
);
if (grown.length > 0) {
  console.error(
    "New Tailwind colour literals (stock palette or arbitrary hex). Use a semantic token (tailwind.config.js colors: work, need, honey, coral, leaf, info, sunk, …) instead:",
  );
  for (const [file, count] of grown) {
    console.error(`  ${file}: ${count} (baseline ${baseline[file] ?? 0})`);
  }
  console.error("Scripts: web/scripts/check-palette-literals.mjs");
  process.exit(1);
}
const shrunk = Object.keys(baseline).filter(
  (file) => (counts[file] ?? 0) < baseline[file],
);
if (shrunk.length > 0) {
  console.log(
    `Palette literals: ${shrunk.length} file(s) below baseline — run with --update to lock the gain in.`,
  );
}
console.log("Palette literals: no new literals.");
